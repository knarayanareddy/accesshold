import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AccessContractDocument,
  Predicate,
} from "../../packages/contracts/src/index.js";
import {
  evaluateAccessContract,
  evaluatePredicate,
  type FeatureRegistry,
} from "../../packages/policy-engine/src/index.js";
import {
  resolveConfirmationOutcome,
  transitionRecovery,
} from "../../packages/domain/src/index.js";

function readJson<T>(relative: string): T {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../${relative}`, import.meta.url)),
      "utf8",
    ),
  ) as T;
}

const registry = readJson<FeatureRegistry>("content/feature-registry/v1.json");
const example = readJson<AccessContractDocument>(
  "examples/access-contract.example.json",
);
const width = registry.features.find(
  (item) => item.key === "hotel.room.door_width",
)!;
const shower = registry.features.find(
  (item) => item.key === "hotel.room.roll_in_shower",
)!;

function predicate(
  operator: Predicate["operator"],
  value: Predicate["value"],
  unit?: string,
): Predicate {
  return {
    feature: "hotel.room.door_width",
    operator,
    value,
    ...(unit ? { unit } : {}),
  };
}

describe("deterministic predicate evaluation", () => {
  it("normalizes inches to centimeters at a hard-constraint threshold", () => {
    expect(
      evaluatePredicate(
        predicate("gte", 80, "cm"),
        { key: width.key, value: 32, unit: "in" },
        width,
      ),
    ).toEqual({
      status: "satisfied",
      code: "threshold_evaluated",
    });
  });

  it("does not round a violation into satisfaction", () => {
    expect(
      evaluatePredicate(
        predicate("gte", 80, "cm"),
        { key: width.key, value: 30, unit: "in" },
        width,
      ).status,
    ).toBe("violated");
  });

  it("keeps missing and null values unknown", () => {
    expect(
      evaluatePredicate(predicate("gte", 80), undefined, width).status,
    ).toBe("unknown");
    expect(
      evaluatePredicate(
        predicate("gte", 80),
        { key: width.key, value: null },
        width,
      ).status,
    ).toBe("unknown");
  });

  it("rejects unregistered features and incompatible value types", () => {
    expect(
      evaluatePredicate(
        predicate("gte", 80),
        { key: width.key, value: 86 },
        undefined,
      ).code,
    ).toBe("unregistered_feature");
    expect(
      evaluatePredicate(
        predicate("gte", 80),
        { key: width.key, value: true },
        width,
      ).code,
    ).toBe("feature_type_mismatch");
  });

  it("supports boolean equality and numeric membership", () => {
    const booleanPredicate: Predicate = {
      feature: shower.key,
      operator: "eq",
      value: true,
    };
    expect(
      evaluatePredicate(
        booleanPredicate,
        { key: shower.key, value: true },
        shower,
      ).status,
    ).toBe("satisfied");
    expect(
      evaluatePredicate(
        predicate("in", [80, 86]),
        { key: width.key, value: 86 },
        width,
      ).status,
    ).toBe("satisfied");
  });
});

describe("Access Contract aggregation", () => {
  it("evaluates the labeled fixture only when fixture mode is explicit", () => {
    const blocked = evaluateAccessContract({
      document: example,
      registry,
      now: new Date("2026-10-23T12:00:00.000Z"),
    });
    expect(blocked.status).toBe("degraded");
    expect(blocked.constraints[0]!.code).toBe("fixture_not_allowed");

    const allowed = evaluateAccessContract({
      document: example,
      registry,
      now: new Date("2026-10-23T12:00:00.000Z"),
      allowFixture: true,
    });
    expect(allowed.status).toBe("active");
    expect(allowed.provenance).toBe("fixture");
    expect(allowed.notice).toContain("not a guarantee");
  });

  it("degrades expired evidence instead of treating it as current", () => {
    const result = evaluateAccessContract({
      document: example,
      registry,
      now: new Date("2026-11-02T12:00:00.000Z"),
      allowFixture: true,
    });
    expect(result.status).toBe("degraded");
    expect(result.constraints[0]!.code).toBe("evidence_stale");
  });

  it("returns violated for a directly contradicted hard feature", () => {
    const document = structuredClone(example);
    document.evidence[0]!.features[0]!.value = false;
    const result = evaluateAccessContract({
      document,
      registry,
      now: new Date("2026-10-23T12:00:00.000Z"),
      allowFixture: true,
    });
    expect(result.status).toBe("violated");
  });

  it("keeps conflicting evidence unknown rather than choosing a winner", () => {
    const document = structuredClone(example);
    const conflicting = structuredClone(document.evidence[0]!);
    conflicting.evidence_id = "01000000000000000000000007";
    conflicting.features[0]!.value = false;
    document.evidence.push(conflicting);
    document.constraints[0]!.evidence_ids.push(conflicting.evidence_id);
    const result = evaluateAccessContract({
      document,
      registry,
      now: new Date("2026-10-23T12:00:00.000Z"),
      allowFixture: true,
    });
    expect(result.status).toBe("degraded");
    expect(result.constraints[0]!.code).toBe("conflicting_evidence");
  });

  it("does not promote preferences into hard-constraint violations", () => {
    const document = structuredClone(example);
    document.constraints[0]!.priority = "preference";
    document.evidence[0]!.features[0]!.value = false;
    const result = evaluateAccessContract({
      document,
      registry,
      now: new Date("2026-10-23T12:00:00.000Z"),
      allowFixture: true,
    });
    expect(result.status).toBe("degraded");
    expect(result.constraints[0]!.status).toBe("violated");
  });
});

describe("recovery truth", () => {
  it("does not complete directly after provider execution", () => {
    expect(transitionRecovery("executing", "awaiting_confirmation")).toBe(
      "awaiting_confirmation",
    );
    expect(() => transitionRecovery("executing", "completed")).toThrow(
      "Invalid recovery transition",
    );
  });

  it("requires a replacement confirmation and successful hard-constraint revalidation", () => {
    expect(
      resolveConfirmationOutcome({
        state: "awaiting_confirmation",
        replacementConfirmationImported: false,
        allHardConstraintsSatisfiedOrNotApplicable: true,
      }),
    ).toBe("awaiting_confirmation");
    expect(
      resolveConfirmationOutcome({
        state: "awaiting_confirmation",
        replacementConfirmationImported: true,
        allHardConstraintsSatisfiedOrNotApplicable: false,
      }),
    ).toBe("detected");
    expect(
      resolveConfirmationOutcome({
        state: "awaiting_confirmation",
        replacementConfirmationImported: true,
        allHardConstraintsSatisfiedOrNotApplicable: true,
      }),
    ).toBe("completed");
  });
});
