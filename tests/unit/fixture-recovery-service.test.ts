import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import {
  FixtureRecoveryService,
  type FixtureRecoveryOption,
  type RecoveryVersionBinding,
} from "../../services/recovery/src/fixture-recovery-service.js";

const example = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../examples/access-contract.example.json", import.meta.url),
    ),
    "utf8",
  ),
) as AccessContractDocument;
const actor = example.traveler_id;
let now = new Date("2026-10-23T12:00:00.000Z");
const clock = () => now;

function document(version = 4): AccessContractDocument {
  return {
    ...structuredClone(example),
    status: "violated",
    version,
    updated_at: "2026-10-23T12:00:00.000Z",
  };
}

function option(id = "plan-a"): FixtureRecoveryOption {
  return {
    option_id: id,
    summary: `TEST replacement for ${id}`,
    action: "sandbox_rebook",
    asset_id: example.assets[0]!.asset_id,
    asset_version: 1,
    evidence_id: example.evidence[0]!.evidence_id,
    evidence_version: 1,
    replacement_provider_reference: `TEST-${id.toUpperCase()}`,
    amount_minor: 0,
    currency: "EUR",
    terms: "Fixture terms; no live inventory or booking.",
    inventory_token: `inventory-${id}-v1`,
    expires_at: "2026-10-23T12:30:00.000Z",
    unknowns: ["Replacement provider confirmation is still required."],
  };
}

function binding(): RecoveryVersionBinding {
  return {
    asset_id: example.assets[0]!.asset_id,
    asset_version: 1,
    evidence_id: example.evidence[0]!.evidence_id,
    evidence_version: 1,
  };
}

function service(bindings: RecoveryVersionBinding[] = [binding()]) {
  now = new Date("2026-10-23T12:00:00.000Z");
  return new FixtureRecoveryService(clock, bindings);
}

function approve(
  recovery: FixtureRecoveryService,
  planHash: string,
  current = document(),
) {
  return recovery.approve({
    document: current,
    planHash,
    actorTravelerId: actor,
    method: "web",
    recentAuthentication: true,
  });
}

describe("Fixture recovery option, approval, and confirmation boundaries", () => {
  it("hashes the complete plan and always offers a no-action option", () => {
    const recovery = service();
    const current = document();
    const offered = recovery.offerPlans({
      document: current,
      caseId: "case-1",
      options: [option()],
    });
    const same = service().offerPlans({
      document: current,
      caseId: "case-1",
      options: [option()],
    });
    expect(offered.plans[0]!.plan_hash).toBe(same.plans[0]!.plan_hash);
    expect(offered.no_action.option_id).toBe("no_action");
    const empty = service().offerPlans({
      document: current,
      caseId: "case-empty",
      options: [],
    });
    expect(empty.plans).toEqual([]);
    expect(empty.no_action.option_id).toBe("no_action");
    expect(offered.plans[0]!.expires_at).toBe("2026-10-23T12:10:00.000Z");
    const mutations: Array<(value: FixtureRecoveryOption) => void> = [
      (value) => {
        value.summary = "Different option";
      },
      (value) => {
        value.asset_version = 2;
      },
      (value) => {
        value.evidence_version = 2;
      },
      (value) => {
        value.amount_minor = 1;
      },
      (value) => {
        value.terms = "Changed terms";
      },
      (value) => {
        value.inventory_token = "changed-inventory";
      },
      (value) => {
        value.expires_at = "2026-10-23T12:45:00.000Z";
      },
    ];
    for (const mutate of mutations) {
      const changed = option();
      mutate(changed);
      const result = service([
        {
          ...binding(),
          asset_version: changed.asset_version,
          evidence_version: changed.evidence_version,
        },
      ]).offerPlans({
        document: current,
        caseId: "case-1",
        options: [changed],
      });
      expect(result.plans[0]!.plan_hash).not.toBe(offered.plans[0]!.plan_hash);
    }
    expect(() =>
      recovery.offerPlans({
        document: current,
        caseId: "case-1",
        options: [{ ...option(), asset_id: "missing" }],
      }),
    ).toThrow("recovery_option_binding_not_found");
    expect(() =>
      service().offerPlans({
        document: current,
        caseId: "case-version-mismatch",
        options: [{ ...option(), asset_version: 99 }],
      }),
    ).toThrow("recovery_option_version_binding_mismatch");
  });

  it("rejects stale price, inventory, contract versions, and expired approvals", () => {
    const priceChange = service();
    const original = priceChange.offerPlans({
      document: document(),
      caseId: "case-price",
      options: [option()],
    }).plans[0]!;
    priceChange.offerPlans({
      document: document(),
      caseId: "case-price",
      options: [{ ...option(), amount_minor: 1 }],
    });
    expect(() => approve(priceChange, original.plan_hash)).toThrow(
      "stale_recovery_plan",
    );

    const versionChange = service();
    const versioned = versionChange.offerPlans({
      document: document(),
      caseId: "case-version",
      options: [option()],
    }).plans[0]!;
    expect(() =>
      approve(versionChange, versioned.plan_hash, document(5)),
    ).toThrow("stale_recovery_plan");

    const expired = service();
    const expiring = expired.offerPlans({
      document: document(),
      caseId: "case-expiry",
      options: [option()],
    }).plans[0]!;
    now = new Date("2026-10-23T12:10:00.000Z");
    expect(() => approve(expired, expiring.plan_hash)).toThrow(
      "recovery_plan_expired",
    );
  });

  it("enforces actor, cost, authentication, and exact plan binding", () => {
    const recovery = service();
    const current = document();
    const plans = recovery.offerPlans({
      document: current,
      caseId: "case-binding",
      options: [option("plan-a"), option("plan-b")],
    }).plans;
    const planA = plans.find((plan) => plan.option.option_id === "plan-a")!;
    const planB = plans.find((plan) => plan.option.option_id === "plan-b")!;
    expect(() =>
      recovery.approve({
        document: current,
        planHash: planA.plan_hash,
        actorTravelerId: "other-traveler",
        method: "web",
        recentAuthentication: true,
      }),
    ).toThrow("trip_access_denied");
    expect(() =>
      recovery.approve({
        document: current,
        planHash: planA.plan_hash,
        actorTravelerId: actor,
        method: "web",
        recentAuthentication: false,
      }),
    ).toThrow("recent_web_authentication_required");
    approve(recovery, planA.plan_hash);
    expect(() =>
      recovery.execute({
        approvalPlanHash: planA.plan_hash,
        submittedPlanHash: planB.plan_hash,
        actorTravelerId: actor,
      }),
    ).toThrow("approval_is_bound_to_a_different_plan");

    const overCost = service();
    const costly = overCost.offerPlans({
      document: current,
      caseId: "case-cost",
      options: [{ ...option(), amount_minor: 1 }],
    }).plans[0]!;
    expect(() => approve(overCost, costly.plan_hash)).toThrow(
      "recovery_action_exceeds_approval_policy",
    );
  });

  it("records one TEST PROVIDER receipt and resolves confirmation only after execution", () => {
    const recovery = service();
    const current = document();
    const plan = recovery.offerPlans({
      document: current,
      caseId: "case-execution",
      options: [option()],
    }).plans[0]!;
    expect(() =>
      recovery.importConfirmation({
        planHash: plan.plan_hash,
        actorTravelerId: actor,
        contractVersion: 5,
        confirmationSha256: "a".repeat(64),
        allHardConstraintsSatisfiedOrNotApplicable: true,
      }),
    ).toThrow("fixture_action_receipt_required");
    approve(recovery, plan.plan_hash);
    const executed = recovery.execute({
      approvalPlanHash: plan.plan_hash,
      submittedPlanHash: plan.plan_hash,
      actorTravelerId: actor,
    });
    expect(executed.duplicate).toBe(false);
    expect(executed.receipt.provider).toBe("TEST PROVIDER");
    expect(executed.receipt.live_action).toBe(false);
    expect(executed.plan.state).toBe("awaiting_confirmation");
    const duplicate = recovery.execute({
      approvalPlanHash: plan.plan_hash,
      submittedPlanHash: plan.plan_hash,
      actorTravelerId: actor,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.receipt).toEqual(executed.receipt);
    expect(recovery.receiptCount).toBe(1);
    expect(() =>
      recovery.importConfirmation({
        planHash: plan.plan_hash,
        actorTravelerId: actor,
        contractVersion: 4,
        confirmationSha256: "a".repeat(64),
        allHardConstraintsSatisfiedOrNotApplicable: true,
      }),
    ).toThrow("invalid_or_stale_replacement_confirmation");

    const unresolved = recovery.importConfirmation({
      planHash: plan.plan_hash,
      actorTravelerId: actor,
      contractVersion: 5,
      confirmationSha256: "a".repeat(64),
      allHardConstraintsSatisfiedOrNotApplicable: false,
    });
    expect(unresolved.plan.state).toBe("detected");
    expect(
      recovery.importConfirmation({
        planHash: plan.plan_hash,
        actorTravelerId: actor,
        contractVersion: 5,
        confirmationSha256: "a".repeat(64),
        allHardConstraintsSatisfiedOrNotApplicable: false,
      }).duplicate,
    ).toBe(true);
    expect(() =>
      recovery.importConfirmation({
        planHash: plan.plan_hash,
        actorTravelerId: actor,
        contractVersion: 5,
        confirmationSha256: "a".repeat(64),
        allHardConstraintsSatisfiedOrNotApplicable: true,
      }),
    ).toThrow("replacement_confirmation_replay_conflict");
    const completed = recovery.importConfirmation({
      planHash: plan.plan_hash,
      actorTravelerId: actor,
      contractVersion: 6,
      confirmationSha256: "b".repeat(64),
      allHardConstraintsSatisfiedOrNotApplicable: true,
    });
    expect(completed.plan.state).toBe("completed");
    expect(
      recovery.importConfirmation({
        planHash: plan.plan_hash,
        actorTravelerId: actor,
        contractVersion: 6,
        confirmationSha256: "b".repeat(64),
        allHardConstraintsSatisfiedOrNotApplicable: true,
      }).duplicate,
    ).toBe(true);
    expect(recovery.receiptCount).toBe(1);
  });

  it("expires an approved plan before execution without creating a receipt", () => {
    const recovery = service();
    const plan = recovery.offerPlans({
      document: document(),
      caseId: "case-approved-expiry",
      options: [option()],
    }).plans[0]!;
    approve(recovery, plan.plan_hash);
    now = new Date("2026-10-23T12:10:00.000Z");
    expect(() =>
      recovery.execute({
        approvalPlanHash: plan.plan_hash,
        submittedPlanHash: plan.plan_hash,
        actorTravelerId: actor,
      }),
    ).toThrow("recovery_approval_expired");
    expect(recovery.receiptCount).toBe(0);
  });
});
