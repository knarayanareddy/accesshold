import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type {
  AccessContractDocument,
  ProviderQuestionTemplateSet,
} from "../../packages/contracts/src/index.js";
import { buildProviderQuestionDraft } from "../../packages/domain/src/provider-questions.js";
import type { FeatureRegistry } from "../../packages/policy-engine/src/index.js";

function projectPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(projectPath(relative), "utf8")) as T;
}

const accessSchema = readJson<object>("schemas/access-contract.schema.json");
const questionSchema = readJson<object>(
  "schemas/provider-question.schema.json",
);
const registry = readJson<FeatureRegistry>("content/feature-registry/v1.json");
const templates = readJson<ProviderQuestionTemplateSet>(
  "content/provider-questions/v1.json",
);
const example = readJson<AccessContractDocument>(
  "examples/access-contract.example.json",
);
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});
addFormats(ajv);
ajv.addSchema(accessSchema);
const validate = ajv.compile(questionSchema);

function draft() {
  return buildProviderQuestionDraft({
    document: example,
    requestId: "6f7f8d4b-6eac-4f57-b9f9-63a4d6eb8c87",
    constraintId: example.constraints[0]!.constraint_id,
    assetId: example.assets[0]!.asset_id,
    recipient: "access@provider.example",
    templates,
    now: new Date("2026-10-24T12:00:00.000Z"),
  });
}

describe("provider verification request contract", () => {
  it("keeps the packaged schema in sync and covers every registry feature", () => {
    expect(
      readFileSync(
        projectPath("packages/contracts/provider-question.schema.json"),
        "utf8",
      ),
    ).toBe(
      readFileSync(
        projectPath("schemas/provider-question.schema.json"),
        "utf8",
      ),
    );
    const featureKeys = registry.features.map((feature) => feature.key).sort();
    const templateKeys = templates.templates.map((item) => item.feature).sort();
    expect(templateKeys).toEqual(featureKeys);
    expect(new Set(templateKeys).size).toBe(templateKeys.length);
  });

  it("validates a complete immutable draft without exposing traveler wording", () => {
    const result = draft();
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result.status).toBe("draft");
    expect(result.body).not.toContain(example.constraints[0]!.traveler_text);
    expect(result.body).toContain(
      "does not assume or guarantee physical accessibility",
    );
    expect(result.approval_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects malformed and already-sent objects at the contract boundary", () => {
    const invalid = { ...draft(), status: "sent" };
    expect(validate(invalid)).toBe(false);
    const missingRecipient = { ...draft() } as Record<string, unknown>;
    delete missingRecipient.recipient;
    expect(validate(missingRecipient)).toBe(false);
  });
});
