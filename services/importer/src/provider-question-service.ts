import type {
  AccessContractDocument,
  ProviderQuestionDraft,
  ProviderQuestionTemplateSet,
} from "../../../packages/contracts/src/index.js";
import { buildProviderQuestionDraft } from "../../../packages/domain/src/provider-questions.js";
import type {
  ProviderQuestionMailAdapter,
  ProviderQuestionReceipt,
} from "../../../packages/adapters/ses/src/index.js";

export interface ProviderQuestionContractReader {
  getTrip(
    tripId: string,
    actorTravelerId: string,
  ): Promise<{ contract: AccessContractDocument }>;
}

export interface DraftProviderQuestionInput {
  tripId: string;
  actorTravelerId: string;
  expectedContractVersion: number;
  constraintId: string;
  assetId: string;
  recipient: string;
  idempotencyKey: string;
}

export interface ApproveProviderQuestionInput {
  requestId: string;
  actorTravelerId: string;
  expectedContractVersion: number;
  approvedHash: string;
}

export interface ProviderQuestionDraftResult {
  draft: ProviderQuestionDraft;
  duplicate: boolean;
}

export interface ProviderQuestionSendResult {
  draft: ProviderQuestionDraft;
  receipt: ProviderQuestionReceipt;
  duplicate: boolean;
}

type StoredRequestState = "draft" | "sending" | "send_outcome_unknown" | "sent";

interface StoredRequest {
  draft: ProviderQuestionDraft;
  actorTravelerId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  state: StoredRequestState;
  receipt?: ProviderQuestionReceipt;
}

function canonicalEmail(value: string): string {
  return value.trim().toLowerCase();
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Creates an inspectable question, then sends it only after the owner approves
 * the exact hash and unchanged contract version. This in-memory service is a
 * fixture composition; production requires durable request/outbox storage.
 */
export class ProviderQuestionService {
  private readonly requests = new Map<string, StoredRequest>();
  private readonly idempotencyIndex = new Map<string, string>();

  constructor(
    private readonly contracts: ProviderQuestionContractReader,
    private readonly adapter: ProviderQuestionMailAdapter,
    private readonly templates: ProviderQuestionTemplateSet,
    private readonly clock: () => Date = () => new Date(),
    private readonly requestIdFactory: () => string = () =>
      globalThis.crypto.randomUUID(),
  ) {}

  async draftRequest(
    input: DraftProviderQuestionInput,
  ): Promise<ProviderQuestionDraftResult> {
    if (!input.idempotencyKey.trim())
      throw new Error("provider_question_idempotency_key_required");
    const inputFingerprint = fingerprint({
      tripId: input.tripId,
      actorTravelerId: input.actorTravelerId,
      expectedContractVersion: input.expectedContractVersion,
      constraintId: input.constraintId,
      assetId: input.assetId,
      recipient: canonicalEmail(input.recipient),
    });
    const existingId = this.idempotencyIndex.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.request(existingId);
      if (existing.inputFingerprint !== inputFingerprint) {
        throw new Error("provider_question_idempotency_conflict");
      }
      return { draft: clone(existing.draft), duplicate: true };
    }

    const view = await this.contracts.getTrip(
      input.tripId,
      input.actorTravelerId,
    );
    if (view.contract.version !== input.expectedContractVersion)
      throw new Error("provider_question_contract_version_stale");
    const requestId = this.requestIdFactory();
    if (this.requests.has(requestId))
      throw new Error("provider_question_request_id_conflict");
    const draft = buildProviderQuestionDraft({
      document: view.contract,
      requestId,
      constraintId: input.constraintId,
      assetId: input.assetId,
      recipient: input.recipient,
      templates: this.templates,
      now: this.clock(),
    });
    const record: StoredRequest = {
      draft,
      actorTravelerId: input.actorTravelerId,
      idempotencyKey: input.idempotencyKey,
      inputFingerprint,
      state: "draft",
    };
    this.requests.set(requestId, record);
    this.idempotencyIndex.set(input.idempotencyKey, requestId);
    return { draft: clone(draft), duplicate: false };
  }

  async approveAndSend(
    input: ApproveProviderQuestionInput,
  ): Promise<ProviderQuestionSendResult> {
    const stored = this.request(input.requestId);
    if (stored.actorTravelerId !== input.actorTravelerId)
      throw new Error("provider_question_actor_mismatch");
    if (stored.draft.approval_hash !== input.approvedHash)
      throw new Error("provider_question_approval_hash_mismatch");
    if (stored.draft.contract_version !== input.expectedContractVersion)
      throw new Error("provider_question_contract_version_stale");
    if (stored.state === "sent" && stored.receipt) {
      return {
        draft: clone(stored.draft),
        receipt: clone(stored.receipt),
        duplicate: true,
      };
    }
    if (stored.state === "sending")
      throw new Error("provider_question_send_in_progress");
    if (stored.state === "send_outcome_unknown")
      throw new Error("provider_question_send_requires_reconciliation");
    if (stored.state !== "draft")
      throw new Error("provider_question_not_approvable");

    const current = await this.contracts.getTrip(
      stored.draft.trip_id,
      input.actorTravelerId,
    );
    if (current.contract.version !== stored.draft.contract_version) {
      throw new Error("provider_question_contract_changed");
    }
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("provider_question_clock_invalid");
    if (now.getTime() >= Date.parse(stored.draft.expires_at))
      throw new Error("provider_question_approval_expired");

    stored.state = "sending";
    try {
      const receipt = await this.adapter.sendQuestion({
        request_id: stored.draft.request_id,
        recipient: stored.draft.recipient,
        subject: stored.draft.subject,
        text_body: stored.draft.body,
      });
      if (
        receipt.request_id !== stored.draft.request_id ||
        receipt.provider_confirmation_received
      ) {
        stored.state = "send_outcome_unknown";
        throw new Error("provider_question_receipt_invalid");
      }
      stored.state = "sent";
      stored.receipt = clone(receipt);
      return {
        draft: clone(stored.draft),
        receipt: clone(receipt),
        duplicate: false,
      };
    } catch (error) {
      if (stored.state === "sending") stored.state = "send_outcome_unknown";
      throw error;
    }
  }

  getDraft(requestId: string, actorTravelerId: string): ProviderQuestionDraft {
    const stored = this.request(requestId);
    if (stored.actorTravelerId !== actorTravelerId)
      throw new Error("provider_question_actor_mismatch");
    return clone(stored.draft);
  }

  private request(requestId: string): StoredRequest {
    const stored = this.requests.get(requestId);
    if (!stored) throw new Error("provider_question_not_found");
    return stored;
  }

  get requestCount(): number {
    return this.requests.size;
  }
}
