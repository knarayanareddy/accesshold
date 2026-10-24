import { sha256Hex } from "../../../packages/domain/src/hash.js";
import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";
import { resolveConfirmationOutcome } from "../../../packages/domain/src/index.js";

export interface RecoveryVersionBinding {
  asset_id: string;
  asset_version: number;
  evidence_id: string;
  evidence_version: number;
}

export interface FixtureRecoveryOption {
  option_id: string;
  summary: string;
  action: "sandbox_rebook";
  asset_id: string;
  asset_version: number;
  evidence_id: string;
  evidence_version: number;
  replacement_provider_reference: string;
  amount_minor: number;
  currency: string;
  terms: string;
  inventory_token: string;
  expires_at: string;
  unknowns: string[];
}

export type RecoveryPlanState =
  | "options_ready"
  | "approved"
  | "executing"
  | "awaiting_confirmation"
  | "completed"
  | "detected"
  | "stale"
  | "expired";

export interface RecoveryPlan {
  plan_hash: string;
  case_id: string;
  trip_id: string;
  contract_version: number;
  option: FixtureRecoveryOption;
  action_list: ["sandbox_rebook"];
  created_at: string;
  expires_at: string;
  state: RecoveryPlanState;
}

export interface RecoveryApproval {
  approval_id: string;
  plan_hash: string;
  contract_version: number;
  actor_traveler_id: string;
  method: "voice" | "web";
  approved_at: string;
  expires_at: string;
}

export interface FixtureActionReceipt {
  receipt_id: string;
  plan_hash: string;
  case_id: string;
  status: "test_change_recorded";
  provider: "TEST PROVIDER";
  recorded_at: string;
  fixture_action_recorded: true;
  live_action: false;
}

export interface RecoveryExecutionResult {
  plan: RecoveryPlan;
  receipt: FixtureActionReceipt;
  duplicate: boolean;
}

export interface ConfirmationResult {
  plan: RecoveryPlan;
  duplicate: boolean;
}

interface StoredConfirmation {
  confirmation_sha256: string;
  contract_version: number;
  state: "completed" | "detected";
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join("")}}`;
}

function fingerprint(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/** Plan-bound approvals and a separate TEST PROVIDER outbox. No network or live action. */
export class FixtureRecoveryService {
  private readonly plans = new Map<string, RecoveryPlan>();
  private readonly approvals = new Map<string, RecoveryApproval>();
  private readonly receipts = new Map<string, FixtureActionReceipt>();
  private readonly confirmations = new Map<string, StoredConfirmation>();

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly versionBindings: RecoveryVersionBinding[] = [],
  ) {}

  private now(): Date {
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("invalid_recovery_clock");
    return now;
  }

  private plan(planHash: string): RecoveryPlan {
    const plan = this.plans.get(planHash);
    if (!plan) throw new Error("recovery_plan_not_found");
    return plan;
  }

  private actor(plan: RecoveryPlan, actorTravelerId: string): void {
    const approval = this.approvals.get(plan.plan_hash);
    if (approval && approval.actor_traveler_id !== actorTravelerId) {
      throw new Error("recovery_actor_mismatch");
    }
  }

  offerPlans(input: {
    document: AccessContractDocument;
    caseId: string;
    options: FixtureRecoveryOption[];
  }): {
    plans: RecoveryPlan[];
    no_action: { option_id: "no_action"; summary: string; unknowns: string[] };
  } {
    const { document, caseId, options } = input;
    if (
      document.provenance !== "fixture" ||
      !caseId.trim() ||
      !["degraded", "violated", "recovering"].includes(document.status)
    ) {
      throw new Error("invalid_fixture_recovery_context");
    }
    const now = this.now();
    const optionIds = new Set<string>();
    for (const option of options) {
      if (
        optionIds.has(option.option_id) ||
        !option.option_id.trim() ||
        !option.summary.trim() ||
        option.summary.length > 500 ||
        !option.terms.trim() ||
        option.terms.length > 1000 ||
        !option.inventory_token.trim() ||
        !option.replacement_provider_reference.startsWith("TEST-") ||
        option.action !== "sandbox_rebook" ||
        !Number.isSafeInteger(option.asset_version) ||
        option.asset_version < 0 ||
        !Number.isSafeInteger(option.evidence_version) ||
        option.evidence_version < 0 ||
        !Number.isSafeInteger(option.amount_minor) ||
        option.amount_minor < 0 ||
        !/^[A-Z]{3}$/.test(option.currency) ||
        !validInstant(option.expires_at) ||
        Date.parse(option.expires_at) <= now.getTime() ||
        option.unknowns.some((unknown) => !unknown.trim())
      ) {
        throw new Error("invalid_fixture_recovery_option");
      }
      optionIds.add(option.option_id);
      const asset = document.assets.find(
        (item) => item.asset_id === option.asset_id,
      );
      const evidence = document.evidence.find(
        (item) => item.evidence_id === option.evidence_id,
      );
      if (!asset || !evidence || evidence.asset_id !== asset.asset_id) {
        throw new Error("recovery_option_binding_not_found");
      }
      const binding = this.versionBindings.find(
        (item) =>
          item.asset_id === option.asset_id &&
          item.evidence_id === option.evidence_id,
      );
      if (
        !binding ||
        binding.asset_version !== option.asset_version ||
        binding.evidence_version !== option.evidence_version
      ) {
        throw new Error("recovery_option_version_binding_mismatch");
      }
    }

    const nextFingerprints = new Map(
      options.map((option) => [option.option_id, fingerprint(option)]),
    );
    for (const plan of this.plans.values()) {
      if (plan.case_id !== caseId || plan.state === "completed") continue;
      const unchanged =
        plan.contract_version === document.version &&
        nextFingerprints.get(plan.option.option_id) ===
          fingerprint(plan.option);
      if (!unchanged) plan.state = "stale";
    }

    const plans = options.map((option) => {
      const expiryMs = Math.min(
        Date.parse(option.expires_at),
        now.getTime() + 10 * 60 * 1000,
      );
      const unsigned: Omit<RecoveryPlan, "plan_hash" | "state"> = {
        case_id: caseId,
        trip_id: document.trip.trip_id,
        contract_version: document.version,
        option: clone(option),
        action_list: ["sandbox_rebook"],
        created_at: now.toISOString(),
        expires_at: new Date(expiryMs).toISOString(),
      };
      const plan: RecoveryPlan = {
        ...unsigned,
        plan_hash: fingerprint(unsigned),
        state: "options_ready",
      };
      if (this.plans.has(plan.plan_hash)) {
        throw new Error("duplicate_recovery_plan_hash");
      }
      this.plans.set(plan.plan_hash, plan);
      return clone(plan);
    });
    return {
      plans,
      no_action: {
        option_id: "no_action",
        summary:
          "Keep the current itinerary; do not execute a recovery action.",
        unknowns: [
          "Existing accessibility constraints and evidence remain unchanged.",
        ],
      },
    };
  }

  approve(input: {
    document: AccessContractDocument;
    planHash: string;
    actorTravelerId: string;
    method: "voice" | "web";
    recentAuthentication: boolean;
  }): RecoveryApproval {
    const plan = this.plan(input.planHash);
    if (input.actorTravelerId !== input.document.traveler_id) {
      throw new Error("trip_access_denied");
    }
    if (
      plan.trip_id !== input.document.trip.trip_id ||
      plan.contract_version !== input.document.version ||
      plan.state === "stale"
    ) {
      plan.state = "stale";
      throw new Error("stale_recovery_plan");
    }
    if (plan.state !== "options_ready") {
      throw new Error("recovery_plan_is_not_open_for_approval");
    }
    const now = this.now();
    if (now.getTime() >= Date.parse(plan.expires_at)) {
      plan.state = "expired";
      throw new Error("recovery_plan_expired");
    }
    const policy = input.document.approval_policy;
    const max = policy.max_additional_cost;
    if (
      !policy.allowed_actions.includes("sandbox_rebook") ||
      plan.option.currency !== max.currency ||
      plan.option.amount_minor > max.amount_minor
    ) {
      throw new Error("recovery_action_exceeds_approval_policy");
    }
    if (input.method === "web" && !input.recentAuthentication) {
      throw new Error("recent_web_authentication_required");
    }
    if (input.method === "voice" && !policy.voice_approval_allowed) {
      throw new Error("voice_approval_not_allowed");
    }
    const approval: RecoveryApproval = {
      approval_id: `approval-${fingerprint(`${plan.plan_hash}:${now.toISOString()}:${input.method}`).slice(0, 20)}`,
      plan_hash: plan.plan_hash,
      contract_version: plan.contract_version,
      actor_traveler_id: input.actorTravelerId,
      method: input.method,
      approved_at: now.toISOString(),
      expires_at: plan.expires_at,
    };
    plan.state = "approved";
    this.approvals.set(plan.plan_hash, approval);
    return clone(approval);
  }

  execute(input: {
    approvalPlanHash: string;
    submittedPlanHash: string;
    actorTravelerId: string;
  }): RecoveryExecutionResult {
    if (input.approvalPlanHash !== input.submittedPlanHash) {
      throw new Error("approval_is_bound_to_a_different_plan");
    }
    const plan = this.plan(input.submittedPlanHash);
    const approval = this.approvals.get(plan.plan_hash);
    if (!approval || approval.actor_traveler_id !== input.actorTravelerId) {
      throw new Error("plan_bound_approval_required");
    }
    const existing = this.receipts.get(plan.plan_hash);
    if (existing) {
      return { plan: clone(plan), receipt: clone(existing), duplicate: true };
    }
    if (plan.state !== "approved") {
      throw new Error("recovery_plan_is_not_approved");
    }
    const now = this.now();
    if (now.getTime() >= Date.parse(approval.expires_at)) {
      plan.state = "expired";
      throw new Error("recovery_approval_expired");
    }
    plan.state = "executing";
    const receipt: FixtureActionReceipt = {
      receipt_id: `TEST-${fingerprint(`${plan.plan_hash}:${approval.approval_id}`).slice(0, 20).toUpperCase()}`,
      plan_hash: plan.plan_hash,
      case_id: plan.case_id,
      status: "test_change_recorded",
      provider: "TEST PROVIDER",
      recorded_at: now.toISOString(),
      fixture_action_recorded: true,
      live_action: false,
    };
    plan.state = "awaiting_confirmation";
    this.receipts.set(plan.plan_hash, receipt);
    return { plan: clone(plan), receipt: clone(receipt), duplicate: false };
  }

  importConfirmation(input: {
    planHash: string;
    actorTravelerId: string;
    contractVersion: number;
    confirmationSha256: string;
    allHardConstraintsSatisfiedOrNotApplicable: boolean;
  }): ConfirmationResult {
    const plan = this.plan(input.planHash);
    this.actor(plan, input.actorTravelerId);
    if (!this.receipts.has(plan.plan_hash)) {
      throw new Error("fixture_action_receipt_required");
    }
    if (
      !/^[0-9a-f]{64}$/.test(input.confirmationSha256) ||
      !Number.isSafeInteger(input.contractVersion) ||
      input.contractVersion <= plan.contract_version
    ) {
      throw new Error("invalid_or_stale_replacement_confirmation");
    }
    const existing = this.confirmations.get(plan.plan_hash);
    if (existing) {
      if (
        existing.confirmation_sha256 === input.confirmationSha256 &&
        existing.contract_version === input.contractVersion &&
        existing.state ===
          (input.allHardConstraintsSatisfiedOrNotApplicable
            ? "completed"
            : "detected")
      ) {
        return { plan: clone(plan), duplicate: true };
      }
      if (existing.state === "completed") {
        throw new Error("completed_recovery_confirmation_conflict");
      }
      if (
        existing.confirmation_sha256 === input.confirmationSha256 &&
        existing.contract_version === input.contractVersion
      ) {
        throw new Error("replacement_confirmation_replay_conflict");
      }
    }
    const state = resolveConfirmationOutcome({
      state: "awaiting_confirmation",
      replacementConfirmationImported: true,
      allHardConstraintsSatisfiedOrNotApplicable:
        input.allHardConstraintsSatisfiedOrNotApplicable,
    });
    if (state !== "completed" && state !== "detected") {
      throw new Error("invalid_fixture_confirmation_outcome");
    }
    plan.state = state;
    this.confirmations.set(plan.plan_hash, {
      confirmation_sha256: input.confirmationSha256,
      contract_version: input.contractVersion,
      state,
    });
    return { plan: clone(plan), duplicate: false };
  }

  getPlan(planHash: string): RecoveryPlan {
    return clone(this.plan(planHash));
  }

  getReceipt(planHash: string): FixtureActionReceipt | undefined {
    const receipt = this.receipts.get(planHash);
    return receipt ? clone(receipt) : undefined;
  }

  plansForCase(caseId: string, tripId: string): RecoveryPlan[] {
    return [...this.plans.values()]
      .filter((plan) => plan.case_id === caseId && plan.trip_id === tripId)
      .map(clone);
  }

  get receiptCount(): number {
    return this.receipts.size;
  }
}
