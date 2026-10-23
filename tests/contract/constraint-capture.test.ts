import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import {
  validateAccessContractSemantics,
  type Predicate,
} from "../../packages/contracts/src/index.js";
import {
  createAccessConstraint,
  type ConstraintCaptureDraft,
} from "../../packages/domain/src/index.js";
import type { FeatureRegistry } from "../../packages/policy-engine/src/index.js";

function projectPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(projectPath(relative), "utf8")) as T;
}

const schema = readJson<object>("schemas/access-contract.schema.json");
const example = readJson<AccessContractDocument>(
  "examples/access-contract.example.json",
);
const registry = readJson<FeatureRegistry>("content/feature-registry/v1.json");
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});
addFormats(ajv);
const validate = ajv.compile(schema);
const constraintId = "01000000000000000000000007";
const draft: ConstraintCaptureDraft = {
  traveler_text: "I need a doorway at least 80 cm wide.",
  priority: "hard",
  applies_to: [example.assets[0]!.asset_id],
  predicate: {
    feature: "hotel.room.door_width",
    operator: "gte",
    value: 80,
    unit: "cm",
  },
};

function capturedConstraint(
  input: ConstraintCaptureDraft = draft,
  id = constraintId,
) {
  return createAccessConstraint(input, {
    constraint_id: id,
    assets: example.assets,
    registry,
  });
}

describe("canonical constraint-capture contract", () => {
  it("serializes hard constraints and preferences as a valid, round-trippable contract", () => {
    const preference: ConstraintCaptureDraft = {
      traveler_text: "A shower lip at or below 2 cm would be preferable.",
      priority: "preference",
      applies_to: [example.assets[0]!.asset_id],
      predicate: {
        feature: "hotel.room.shower_lip_height",
        operator: "lte",
        value: 2,
        unit: "cm",
      },
    };
    const document = structuredClone(example);
    document.constraints = [
      capturedConstraint(),
      capturedConstraint(preference, "01000000000000000000000008"),
    ];

    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(validateAccessContractSemantics(document)).toEqual([]);
    const roundTripped = JSON.parse(JSON.stringify(document)) as unknown;
    expect(roundTripped).toEqual(document);
    expect(document.constraints.map((item) => item.priority)).toEqual([
      "hard",
      "preference",
    ]);
    expect(document.constraints[0]).toMatchObject({
      constraint_id: constraintId,
      traveler_text: draft.traveler_text,
      priority: "hard",
      applies_to: [example.assets[0]!.asset_id],
      predicate: draft.predicate,
      status: "unverified",
      evidence_ids: [],
    });
  });

  it("rejects values outside the canonical constraint schema", () => {
    const document = structuredClone(example);
    document.constraints = [capturedConstraint()];
    const invalid = structuredClone(document) as unknown as {
      constraints: Array<Record<string, unknown>>;
    };
    invalid.constraints[0]!.priority = "essential";

    expect(validate(invalid)).toBe(false);
  });

  it("rejects unregistered features, wrong predicate types, and inapplicable assets", () => {
    expect(() =>
      capturedConstraint({
        ...draft,
        predicate: {
          ...draft.predicate,
          feature: "hotel.room.not_registered",
        },
      }),
    ).toThrow("predicate_feature_unregistered");
    expect(() =>
      capturedConstraint({
        ...draft,
        predicate: {
          ...draft.predicate,
          operator: "eq",
          value: "wide",
        } as unknown as Predicate,
      }),
    ).toThrow("predicate_value_type_mismatch");
    expect(() =>
      capturedConstraint({
        ...draft,
        applies_to: ["01000000000000000000000099"],
      }),
    ).toThrow("applicable_asset_not_found");
  });
});
