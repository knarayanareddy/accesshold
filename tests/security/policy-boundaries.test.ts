import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import {
  evaluateAccessContract,
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

describe("policy trust boundaries", () => {
  it("never upgrades a fixture into live evidence through an evaluation option", () => {
    const document = structuredClone(example);
    document.provenance = "live";
    const result = evaluateAccessContract({
      document,
      registry,
      now: new Date("2026-10-23T12:00:00.000Z"),
      allowFixture: true,
    });
    expect(result.status).toBe("degraded");
    expect(result.constraints[0]!.code).toBe("fixture_not_allowed");
  });

  it("does not allow an unlisted provider-document source to satisfy the registry policy", () => {
    const document = structuredClone(example);
    document.provenance = "live";
    document.evidence[0]!.provenance = "live";
    document.evidence[0]!.source_type = "provider_document";
    const result = evaluateAccessContract({
      document,
      registry,
      now: new Date("2026-10-23T12:00:00.000Z"),
    });
    expect(result.status).toBe("degraded");
    expect(result.constraints[0]!.code).toBe("source_not_allowed");
  });
});
