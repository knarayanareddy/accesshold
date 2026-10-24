import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AccessContractDocument,
  ProviderQuestionTemplateSet,
} from "../../packages/contracts/src/index.js";
import {
  FixtureProviderQuestionAdapter,
  SesProviderQuestionAdapter,
  type ProviderQuestionMailAdapter,
} from "../../packages/adapters/ses/src/index.js";
import { ProviderQuestionService } from "../../services/importer/src/provider-question-service.js";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";

function readJson<T>(relative: string): T {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../${relative}`, import.meta.url)),
      "utf8",
    ),
  ) as T;
}

const example = readJson<AccessContractDocument>(
  "examples/access-contract.example.json",
);
const templates = readJson<ProviderQuestionTemplateSet>(
  "content/provider-questions/v1.json",
);
const actor = example.traveler_id;
const tripId = example.trip.trip_id;
const constraintId = example.constraints[0]!.constraint_id;
const assetId = example.assets[0]!.asset_id;
const clock = () => new Date("2026-10-24T12:00:00.000Z");

function contractReader(document: AccessContractDocument = example) {
  return {
    async getTrip(_tripId: string, actorTravelerId: string) {
      if (actorTravelerId !== document.traveler_id)
        throw new Error("trip_access_denied");
      return { contract: structuredClone(document) };
    },
  };
}

function requestInput() {
  return {
    tripId,
    actorTravelerId: actor,
    expectedContractVersion: example.version,
    constraintId,
    assetId,
    recipient: " ACCESS@PROVIDER.EXAMPLE ",
    idempotencyKey: "provider-question-request-001",
  };
}

function service(
  adapter: ProviderQuestionMailAdapter = new FixtureProviderQuestionAdapter(
    clock,
  ),
) {
  return new ProviderQuestionService(
    contractReader(),
    adapter,
    templates,
    clock,
    () => "6f7f8d4b-6eac-4f57-b9f9-63a4d6eb8c87",
  );
}

describe("provider verification question approval flow", () => {
  it("drafts a redacted deterministic question and sends only after exact approval", async () => {
    const adapter = new FixtureProviderQuestionAdapter(clock);
    const app = service(adapter);
    const created = await app.draftRequest(requestInput());

    expect(created.duplicate).toBe(false);
    expect(created.draft).toMatchObject({
      request_id: "6f7f8d4b-6eac-4f57-b9f9-63a4d6eb8c87",
      trip_id: tripId,
      contract_version: example.version,
      constraint_id: constraintId,
      asset_id: assetId,
      recipient: "access@provider.example",
      status: "draft",
      provenance: "fixture",
    });
    expect(created.draft.body).toContain(
      "Does the booked room have a roll-in shower?",
    );
    expect(created.draft.body).not.toContain(
      example.constraints[0]!.traveler_text,
    );
    expect(adapter.receiptCount).toBe(0);

    const sent = await app.approveAndSend({
      requestId: created.draft.request_id,
      actorTravelerId: actor,
      expectedContractVersion: example.version,
      approvedHash: created.draft.approval_hash,
    });
    expect(sent.duplicate).toBe(false);
    expect(sent.receipt).toMatchObject({
      status: "test_message_recorded",
      provider: "TEST PROVIDER",
      live_send: false,
      provider_confirmation_received: false,
    });
    const retry = await app.approveAndSend({
      requestId: created.draft.request_id,
      actorTravelerId: actor,
      expectedContractVersion: example.version,
      approvedHash: created.draft.approval_hash,
    });
    expect(retry.duplicate).toBe(true);
    expect(adapter.receiptCount).toBe(1);
  });

  it("rejects wrong approval, cross-traveler, and stale contract versions without sending", async () => {
    let current = structuredClone(example);
    const adapter = new FixtureProviderQuestionAdapter(clock);
    const app = new ProviderQuestionService(
      contractReaderProxy(() => current),
      adapter,
      templates,
      clock,
      () => "6f7f8d4b-6eac-4f57-b9f9-63a4d6eb8c87",
    );
    const created = await app.draftRequest(requestInput());

    await expect(
      app.approveAndSend({
        requestId: created.draft.request_id,
        actorTravelerId: actor,
        expectedContractVersion: example.version,
        approvedHash: "0".repeat(64),
      }),
    ).rejects.toThrow("provider_question_approval_hash_mismatch");
    await expect(
      app.approveAndSend({
        requestId: created.draft.request_id,
        actorTravelerId: "01000000000000000000000099",
        expectedContractVersion: example.version,
        approvedHash: created.draft.approval_hash,
      }),
    ).rejects.toThrow("provider_question_actor_mismatch");

    current = { ...current, version: current.version + 1 };
    await expect(
      app.approveAndSend({
        requestId: created.draft.request_id,
        actorTravelerId: actor,
        expectedContractVersion: example.version,
        approvedHash: created.draft.approval_hash,
      }),
    ).rejects.toThrow("provider_question_contract_changed");
    expect(adapter.receiptCount).toBe(0);
  });

  it("deduplicates draft retries and rejects idempotency-key reuse for changed content", async () => {
    const app = service();
    const first = await app.draftRequest(requestInput());
    const duplicate = await app.draftRequest(requestInput());
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.draft.request_id).toBe(first.draft.request_id);
    await expect(
      app.draftRequest({
        ...requestInput(),
        recipient: "other@provider.example",
      }),
    ).rejects.toThrow("provider_question_idempotency_conflict");
    expect(app.requestCount).toBe(1);
  });

  it("does not retry an ambiguous SES outcome that could duplicate a message", async () => {
    let calls = 0;
    const failingAdapter: ProviderQuestionMailAdapter = {
      async sendQuestion() {
        calls += 1;
        throw new Error("network_outcome_unknown");
      },
    };
    const app = service(failingAdapter);
    const created = await app.draftRequest(requestInput());
    const approval = {
      requestId: created.draft.request_id,
      actorTravelerId: actor,
      expectedContractVersion: example.version,
      approvedHash: created.draft.approval_hash,
    };
    await expect(app.approveAndSend(approval)).rejects.toThrow(
      "network_outcome_unknown",
    );
    await expect(app.approveAndSend(approval)).rejects.toThrow(
      "provider_question_send_requires_reconciliation",
    );
    expect(calls).toBe(1);
  });

  it("builds an SES plain-text message and reports acceptance, not provider confirmation", async () => {
    let command: SendEmailCommand | undefined;
    const fakeClient = {
      async send(sentCommand: SendEmailCommand) {
        command = sentCommand;
        return { MessageId: "ses-message-1" };
      },
    } as unknown as Pick<SESv2Client, "send">;
    const ses = new SesProviderQuestionAdapter(
      { fromAddress: "accesshold@example.test" },
      fakeClient,
      clock,
    );
    const draft = await service().draftRequest(requestInput());
    const receipt = await ses.sendQuestion({
      request_id: draft.draft.request_id,
      recipient: draft.draft.recipient,
      subject: draft.draft.subject,
      text_body: draft.draft.body,
    });

    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command?.input.Content?.Simple?.Body?.Text?.Data).toContain(
      "Please reply with the source",
    );
    expect(command?.input.Content?.Simple?.Body?.Html).toBeUndefined();
    expect(receipt).toMatchObject({
      message_id: "ses-message-1",
      status: "ses_accepted",
      provider: "Amazon SES",
      live_send: true,
      provider_confirmation_received: false,
    });
  });
});

function contractReaderProxy(current: () => AccessContractDocument): {
  getTrip(
    tripId: string,
    actorTravelerId: string,
  ): Promise<{ contract: AccessContractDocument }>;
} {
  return {
    async getTrip(_tripId, actorTravelerId) {
      const document = current();
      if (document.traveler_id !== actorTravelerId)
        throw new Error("trip_access_denied");
      return { contract: structuredClone(document) };
    },
  };
}
