import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AccessContractDocument,
  Predicate,
} from "../../packages/contracts/src/index.js";
import {
  createAccessConstraint,
  type ConstraintCaptureDraft,
} from "../../packages/domain/src/index.js";
import {
  evaluatePredicate,
  type FeatureRegistry,
} from "../../packages/policy-engine/src/index.js";

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
const assetId = example.assets[0]!.asset_id;
const constraintId = "01000000000000000000000007";
const baseDraft: ConstraintCaptureDraft = {
  traveler_text: "I need a doorway at least 80 cm wide.",
  priority: "hard",
  applies_to: [assetId],
  predicate: {
    feature: "hotel.room.door_width",
    operator: "gte",
    value: 80,
    unit: "cm",
  },
};

function capture(draft: ConstraintCaptureDraft = baseDraft, id = constraintId) {
  return createAccessConstraint(draft, {
    constraint_id: id,
    assets: example.assets,
    registry,
  });
}

describe("Access Contract constraint capture domain", () => {
  it("preserves traveler wording, priority, predicate, and explicit asset scope", () => {
    const wording = "  I need a doorway at least 80 cm wide.  ";
    const selectedAssets = [assetId];
    const input: ConstraintCaptureDraft = {
      ...baseDraft,
      traveler_text: wording,
      applies_to: selectedAssets,
    };

    const constraint = capture(input);
    selectedAssets.push("01000000000000000000000099");

    expect(constraint).toEqual({
      constraint_id: constraintId,
      traveler_text: "I need a doorway at least 80 cm wide.",
      priority: "hard",
      applies_to: [assetId],
      predicate: baseDraft.predicate,
      status: "unverified",
      evidence_ids: [],
    });
    expect(constraint.priority).toBe("hard");
    expect(constraint.evidence_ids).toEqual([]);
  });

  it("keeps preferences as preferences and validates their predicate deterministically", () => {
    const preference: ConstraintCaptureDraft = {
      traveler_text: "A shower lip at or below 2 cm would be preferable.",
      priority: "preference",
      applies_to: [assetId],
      predicate: {
        feature: "hotel.room.shower_lip_height",
        operator: "lte",
        value: 2,
        unit: "cm",
      },
    };
    const constraint = capture(preference);
    const definition = registry.features.find(
      (feature) => feature.key === preference.predicate.feature,
    );

    expect(constraint.priority).toBe("preference");
    expect(constraint.traveler_text).toBe(preference.traveler_text);
    expect(
      evaluatePredicate(
        constraint.predicate,
        { key: preference.predicate.feature, value: 1, unit: "cm" },
        definition,
      ),
    ).toEqual({ status: "satisfied", code: "threshold_evaluated" });
    expect(
      evaluatePredicate(
        constraint.predicate,
        { key: preference.predicate.feature, value: 3, unit: "cm" },
        definition,
      ).status,
    ).toBe("violated");
  });

  it("rejects missing, whitespace-only, and overlong traveler wording", () => {
    expect(() => capture(null as unknown as ConstraintCaptureDraft)).toThrow(
      "constraint_required",
    );
    expect(() => capture({ ...baseDraft, traveler_text: "  \n  " })).toThrow(
      "traveler_text_required",
    );
    expect(() =>
      capture({ ...baseDraft, traveler_text: "x".repeat(501) }),
    ).toThrow("traveler_text_too_long");
  });

  it("requires unique applicable assets that exist on the contract", () => {
    expect(() => capture({ ...baseDraft, applies_to: [] })).toThrow(
      "applicable_asset_required",
    );
    expect(() =>
      capture({ ...baseDraft, applies_to: [assetId, assetId] }),
    ).toThrow("applicable_asset_duplicate");
    expect(() =>
      capture({ ...baseDraft, applies_to: ["01000000000000000000000099"] }),
    ).toThrow("applicable_asset_not_found");
  });

  it("rejects unregistered features and predicates with incompatible types", () => {
    expect(() =>
      capture({
        ...baseDraft,
        predicate: { ...baseDraft.predicate, feature: "hotel.room.unknown" },
      }),
    ).toThrow("predicate_feature_unregistered");
    expect(() =>
      capture({
        ...baseDraft,
        predicate: {
          ...baseDraft.predicate,
          operator: "eq",
          value: true,
        } as unknown as Predicate,
      }),
    ).toThrow("predicate_value_type_mismatch");
    expect(() =>
      capture({
        ...baseDraft,
        predicate: {
          feature: "hotel.room.roll_in_shower",
          operator: "gte",
          value: 1,
        } as Predicate,
      }),
    ).toThrow("predicate_operator_value_mismatch");
  });

  it("rejects invalid membership values, units, and identifiers", () => {
    expect(() =>
      capture({
        ...baseDraft,
        predicate: {
          feature: "hotel.room.door_width",
          operator: "in",
          value: [80, "86"],
        } as unknown as Predicate,
      }),
    ).toThrow("predicate_value_type_mismatch");
    expect(() =>
      capture({
        ...baseDraft,
        predicate: { ...baseDraft.predicate, unit: "ft" },
      }),
    ).toThrow("predicate_unit_not_allowed");
    expect(() =>
      capture({
        ...baseDraft,
        predicate: {
          feature: "hotel.room.door_width",
          operator: "exists",
          value: true,
          unit: "cm",
        },
      }),
    ).toThrow("predicate_unit_not_allowed");
    expect(() => capture(baseDraft, "not-a-ulid")).toThrow(
      "constraint_id_invalid",
    );
  });
});
