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
