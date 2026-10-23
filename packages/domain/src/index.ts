import type {
  AccessAsset,
  AccessConstraint,
  Predicate,
} from "../../contracts/src/index.js";
import type { FeatureRegistry } from "../../policy-engine/src/index.js";

/**
 * Traveler-entered requirement text plus an explicit, deterministic predicate.
 * The predicate is never inferred from or used to rewrite the traveler wording.
 */
export interface ConstraintCaptureDraft {
  traveler_text: string;
  priority: "hard" | "preference";
  applies_to: readonly string[];
  predicate: Predicate;
}

export interface CreateAccessConstraintContext {
  constraint_id: string;
  assets: readonly AccessAsset[];
  registry: FeatureRegistry;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PREDICATE_OPERATORS = new Set([
  "eq",
  "neq",
  "gte",
  "lte",
  "in",
  "exists",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isFiniteNumber(item))
  );
}

function isBooleanArray(value: unknown): value is boolean[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "boolean")
  );
}

function captureIssues(
  draft: ConstraintCaptureDraft,
  context: CreateAccessConstraintContext,
): string[] {
  if (!draft || typeof draft !== "object") return ["constraint_required"];
  const issues = new Set<string>();
  const travelerText =
    typeof draft.traveler_text === "string" ? draft.traveler_text.trim() : "";
  const travelerTextLength = [...travelerText].length;

  if (!ULID_PATTERN.test(context.constraint_id))
    issues.add("constraint_id_invalid");
  if (!travelerText) issues.add("traveler_text_required");
  if (travelerTextLength > 500) issues.add("traveler_text_too_long");
  if (draft.priority !== "hard" && draft.priority !== "preference")
    issues.add("constraint_priority_invalid");

  if (!Array.isArray(draft.applies_to) || draft.applies_to.length === 0) {
    issues.add("applicable_asset_required");
  } else {
    const assetIds = new Set(context.assets.map((asset) => asset.asset_id));
    const selected = new Set<string>();
    for (const assetId of draft.applies_to) {
      if (typeof assetId !== "string" || !assetIds.has(assetId)) {
        issues.add("applicable_asset_not_found");
      }
      if (typeof assetId === "string" && selected.has(assetId)) {
        issues.add("applicable_asset_duplicate");
      }
      if (typeof assetId === "string") selected.add(assetId);
    }
  }

  const predicate = draft.predicate as Predicate | undefined;
  if (!predicate || typeof predicate !== "object") {
    issues.add("predicate_required");
    return [...issues].sort();
  }
  const definition = context.registry.features.find(
    (feature) => feature.key === predicate.feature,
  );
  if (!definition) {
    issues.add("predicate_feature_unregistered");
    return [...issues].sort();
  }
  if (!PREDICATE_OPERATORS.has(predicate.operator)) {
    issues.add("predicate_operator_unsupported");
    return [...issues].sort();
  }

  const value: unknown = predicate.value;
  switch (predicate.operator) {
    case "eq":
    case "neq":
      if (
        (definition.value_type === "number" && !isFiniteNumber(value)) ||
        (definition.value_type === "boolean" && typeof value !== "boolean")
      ) {
        issues.add("predicate_value_type_mismatch");
      }
      break;
    case "gte":
    case "lte":
      if (definition.value_type !== "number" || !isFiniteNumber(value)) {
        issues.add("predicate_operator_value_mismatch");
      }
      break;
    case "in":
      if (
        (definition.value_type === "number" && !isNumberArray(value)) ||
        (definition.value_type === "boolean" && !isBooleanArray(value))
      ) {
        issues.add("predicate_value_type_mismatch");
      }
      break;
    case "exists":
      if (typeof value !== "boolean")
        issues.add("predicate_value_type_mismatch");
      break;
  }

  if (predicate.unit !== undefined) {
    if (
      predicate.operator === "exists" ||
      definition.value_type !== "number" ||
      typeof predicate.unit !== "string" ||
      !definition.allowed_units.includes(predicate.unit)
    ) {
      issues.add("predicate_unit_not_allowed");
    }
  }

  return [...issues].sort();
}

/**
 * Creates a canonical, initially unverified constraint from explicit traveler
 * input. It does not attach evidence or claim that a feature is accessible.
 */
export function createAccessConstraint(
  draft: ConstraintCaptureDraft,
  context: CreateAccessConstraintContext,
): AccessConstraint {
  const issues = captureIssues(draft, context);
  if (issues.length > 0) {
    throw new Error(`constraint_capture_invalid:${issues.join(",")}`);
  }

  return {
    constraint_id: context.constraint_id,
    traveler_text: draft.traveler_text.trim(),
    priority: draft.priority,
    applies_to: [...draft.applies_to],
    predicate: {
      ...draft.predicate,
      value: Array.isArray(draft.predicate.value)
        ? [...draft.predicate.value]
        : draft.predicate.value,
    },
    status: "unverified",
    evidence_ids: [],
  };
}

export const RECOVERY_STATES = [
  "detected",
  "options_ready",
  "awaiting_approval",
  "approved",
  "executing",
  "awaiting_confirmation",
  "action_failed",
  "completed",
  "rejected",
  "expired",
  "human_handoff",
] as const;

export type RecoveryState = (typeof RECOVERY_STATES)[number];

const ALLOWED_TRANSITIONS: Readonly<
  Record<RecoveryState, readonly RecoveryState[]>
> = {
  detected: ["options_ready", "human_handoff"],
  options_ready: ["awaiting_approval", "human_handoff"],
  awaiting_approval: ["approved", "rejected", "expired", "human_handoff"],
  approved: ["executing"],
  executing: ["awaiting_confirmation", "action_failed", "human_handoff"],
  awaiting_confirmation: ["completed", "detected", "human_handoff"],
  action_failed: ["options_ready", "human_handoff"],
  completed: [],
  rejected: [],
  expired: ["options_ready"],
  human_handoff: [],
};

export function canTransitionRecovery(
  from: RecoveryState,
  to: RecoveryState,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionRecovery(
  from: RecoveryState,
  to: RecoveryState,
): RecoveryState {
  if (!canTransitionRecovery(from, to)) {
    throw new Error(`Invalid recovery transition: ${from} -> ${to}`);
  }
  return to;
}

export function resolveConfirmationOutcome(input: {
  state: RecoveryState;
  replacementConfirmationImported: boolean;
  allHardConstraintsSatisfiedOrNotApplicable: boolean;
}): RecoveryState {
  if (input.state !== "awaiting_confirmation") {
    throw new Error("Recovery is not awaiting replacement confirmation");
  }
  if (!input.replacementConfirmationImported) return "awaiting_confirmation";
  return input.allHardConstraintsSatisfiedOrNotApplicable
    ? "completed"
    : "detected";
}
