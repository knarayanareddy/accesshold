import { createHash } from "node:crypto";
import type { AccessContractDocument } from "../../contracts/src/index.js";
import type {
  ProviderQuestionDraft,
  ProviderQuestionTemplateSet,
} from "../../contracts/src/provider-question.js";

export interface BuildProviderQuestionInput {
  document: AccessContractDocument;
  requestId: string;
  constraintId: string;
  assetId: string;
  recipient: string;
  templates: ProviderQuestionTemplateSet;
  now: Date;
  approvalWindowMs?: number;
}

function validInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function safeSingleLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

function isEmailAddress(value: string): boolean {
  return (
    value.length <= 320 &&
    /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(
      value,
    )
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Builds a deterministic, provider-facing question without sending it. */
export function buildProviderQuestionDraft(
  input: BuildProviderQuestionInput,
): ProviderQuestionDraft {
  const { document } = input;
  if (
    document.provenance !== "fixture" ||
    document.status === "draft" ||
    document.status === "closed"
  ) {
    throw new Error("provider_question_requires_active_fixture_trip");
  }
  if (!input.requestId.trim() || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
    throw new Error("provider_question_request_id_invalid");
  }
  if (!Number.isFinite(input.now.getTime()))
    throw new Error("provider_question_clock_invalid");
  if (
    !Number.isSafeInteger(input.approvalWindowMs ?? 600_000) ||
    (input.approvalWindowMs ?? 600_000) < 1
  ) {
    throw new Error("provider_question_approval_window_invalid");
  }

  const recipient = input.recipient.trim().toLowerCase();
  if (!isEmailAddress(recipient))
    throw new Error("provider_question_recipient_invalid");

  const constraint = document.constraints.find(
    (item) => item.constraint_id === input.constraintId,
  );
  if (!constraint) throw new Error("provider_question_constraint_not_found");
  if (!constraint.applies_to.includes(input.assetId))
    throw new Error("provider_question_asset_not_applicable");
  const asset = document.assets.find((item) => item.asset_id === input.assetId);
  if (!asset) throw new Error("provider_question_asset_not_found");

  const template = input.templates.templates.find(
    (item) => item.feature === constraint.predicate.feature,
  );
  if (!template) throw new Error("provider_question_template_not_found");
  if (
    !input.templates.version.trim() ||
    !template.label.trim() ||
    !template.question.trim()
  ) {
    throw new Error("provider_question_template_invalid");
  }

  const now = input.now.toISOString();
  const expiresAt = new Date(
    input.now.getTime() + (input.approvalWindowMs ?? 600_000),
  ).toISOString();
  if (!validInstant(expiresAt))
    throw new Error("provider_question_expiry_invalid");
  const provider = safeSingleLine(asset.provider);
  const providerReference = safeSingleLine(asset.provider_reference);
  if (!provider || !providerReference)
    throw new Error("provider_question_booking_reference_invalid");

  const subject = "Request to confirm a booked travel feature";
  const body = [
    `Hello ${provider} team,`,
    "",
    `Could you please verify this detail for booking reference ${providerReference}?`,
    "",
    `- ${safeSingleLine(template.question)}`,
    "",
    "Please reply with the source of the information or state if you cannot confirm it.",
    "This request does not assume or guarantee physical accessibility.",
  ].join("\n");
  const approvalHash = fingerprint({
    request_id: input.requestId,
    trip_id: document.trip.trip_id,
    contract_version: document.version,
    constraint_id: constraint.constraint_id,
    asset_id: asset.asset_id,
    recipient,
    subject,
    body,
    template_version: input.templates.version,
    expires_at: expiresAt,
  });

  return {
    request_id: input.requestId,
    trip_id: document.trip.trip_id,
    contract_version: document.version,
    constraint_id: constraint.constraint_id,
    asset_id: asset.asset_id,
    provider,
    provider_reference: providerReference,
    recipient,
    subject,
    body,
    template_version: input.templates.version,
    created_at: now,
    expires_at: expiresAt,
    approval_hash: approvalHash,
    status: "draft",
    provenance: "fixture",
  };
}
