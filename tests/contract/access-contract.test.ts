import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  validateAccessContractSemantics,
  type AccessContractDocument,
} from "../../packages/contracts/src/index.js";

function projectPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(projectPath(relative), "utf8")) as unknown;
}

const schema = readJson("schemas/access-contract.schema.json") as object;
const example = readJson(
  "examples/access-contract.example.json",
) as AccessContractDocument;
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});
addFormats(ajv);
const validate = ajv.compile(schema);

describe("canonical Access Contract", () => {
  it("keeps the packaged schema byte-identical to the canonical schema", () => {
    expect(
      readFileSync(
        projectPath("packages/contracts/access-contract.schema.json"),
        "utf8",
      ),
    ).toBe(
      readFileSync(projectPath("schemas/access-contract.schema.json"), "utf8"),
    );
  });

  it("validates and round-trips the fixture without semantic changes", () => {
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.parse(JSON.stringify(example)) as unknown).toEqual(example);
    expect(validateAccessContractSemantics(example)).toEqual([]);
  });

  it("rejects unknown fields and malformed identifiers", () => {
    const invalid = structuredClone(example) as AccessContractDocument & {
      unexpected?: boolean;
    };
    invalid.unexpected = true;
    invalid.contract_id = "not-a-ulid";
    expect(validate(invalid)).toBe(false);
  });

  it("rejects provider-confirmed review evidence semantically", () => {
    const invalid = structuredClone(example);
    invalid.evidence[0]!.source_type = "review";
    expect(validateAccessContractSemantics(invalid)).toContain(
      `review_cannot_be_provider_confirmed:${invalid.evidence[0]!.evidence_id}`,
    );
  });

  it("rejects fixture evidence attached to a live contract", () => {
    const invalid = structuredClone(example);
    invalid.provenance = "live";
    expect(validateAccessContractSemantics(invalid)).toContain(
      `fixture_evidence_in_live_contract:${invalid.evidence[0]!.evidence_id}`,
    );
  });

  it("rejects dangling constraint references", () => {
    const invalid = structuredClone(example);
    invalid.constraints[0]!.evidence_ids = ["01000000000000000000000099"];
    expect(validateAccessContractSemantics(invalid)).toContain(
      `missing_constraint_evidence:${invalid.constraints[0]!.constraint_id}`,
    );
  });
});
