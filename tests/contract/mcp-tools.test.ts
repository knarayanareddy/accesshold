import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

interface McpToolContracts {
  $schema: string;
  $id: string;
  $defs: Record<string, object>;
}

function projectPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(projectPath(relative), "utf8")) as T;
}

const contracts = readJson<McpToolContracts>(
  "packages/contracts/mcp/tools.schema.json",
);
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});
addFormats(ajv);

const tripId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const digest = "a".repeat(64);
const testCases = [
  {
    name: "watch_trip",
    input: { trip_import_id: tripId, confirmed_contract_version: 1 },
    output: {
      trip_id: tripId,
      status: "active",
      unknown_count: 0,
      monitoring_authorized: true,
      provenance: "fixture",
    },
  },
  {
    name: "get_trip_status",
    input: { trip_id: tripId },
    output: {
      trip_id: tripId,
      status: "active",
      hard_constraint_counts: {
        satisfied: 1,
        violated: 0,
        unknown: 0,
        not_applicable: 0,
      },
      unknown_count: 0,
      changed_assets: [],
      as_of: "2026-10-24T12:00:00.000Z",
      card_uri: `ui://accesshold/trip/${tripId}`,
      provenance: "fixture",
    },
  },
  {
    name: "get_evidence",
    input: { trip_id: tripId, constraint_id: tripId },
    output: {
      trip_id: tripId,
      constraint_id: tripId,
      items: [],
      card_uri: `ui://accesshold/evidence/${tripId}`,
      provenance: "fixture",
    },
  },
  {
    name: "list_recovery_options",
    input: { case_id: "case-1" },
    output: {
      case_id: "case-1",
      option_set_version: 1,
      options: [],
      no_action: {
        option_id: "no_action",
        summary: "Keep the current booking.",
      },
      card_uri: "ui://accesshold/case/case-1",
      provenance: "fixture",
    },
  },
  {
    name: "select_recovery_option",
    input: { case_id: "case-1", option_id: "no_action", expected_version: 1 },
    output: {
      plan_id: "plan-1",
      plan_sha256: digest,
      expires_at: "2026-10-24T12:10:00.000Z",
      card_uri: "ui://accesshold/case/case-1",
      provenance: "fixture",
    },
  },
  {
    name: "approve_recovery",
    input: {
      plan_id: "plan-1",
      plan_sha256: digest,
      approval_phrase: "APPROVE RECOVERY",
    },
    output: {
      status: "executed_fixture",
      plan_sha256: digest,
      approval_id: null,
      execution_task_id: "TEST-1",
      provider_notice: "TEST PROVIDER only; no live booking changed.",
      provenance: "fixture",
    },
  },
  {
    name: "request_human_handoff",
    input: { case_id: "case-1", callback_preference: "email" },
    output: {
      handoff_id: "handoff-1",
      status: "fixture_packet_ready_not_sent",
      callback_preference: "email",
      card_uri: "ui://accesshold/case/case-1",
      provenance: "fixture",
    },
  },
  {
    name: "stop_monitoring",
    input: { trip_id: tripId, expected_version: 1 },
    output: {
      trip_id: tripId,
      status: "closed",
      monitoring_authorized: false,
      contract_version: 2,
      provenance: "fixture",
    },
  },
] as const;

function validator(definition: string) {
  return ajv.compile({
    $schema: contracts.$schema,
    $defs: contracts.$defs,
    $ref: `#/$defs/${definition}`,
  });
}

describe("MCP tool JSON Schema contracts", () => {
  it("is a valid JSON Schema 2020-12 document with all eight tool pairs", () => {
    expect(ajv.validateSchema(contracts)).toBe(true);
    expect(
      Object.keys(contracts.$defs).filter((name) => name.endsWith("_input")),
    ).toHaveLength(8);
    expect(testCases).toHaveLength(8);
  }, 15_000);

  it.each(testCases)(
    "validates $name input and output examples",
    ({ name, input, output }) => {
      const inputValidator = validator(`${name}_input`);
      const outputValidator = validator(`${name}_output`);

      expect(inputValidator(input), JSON.stringify(inputValidator.errors)).toBe(
        true,
      );
      expect(
        outputValidator(output),
        JSON.stringify(outputValidator.errors),
      ).toBe(true);
      expect(inputValidator({ ...input, unexpected: true })).toBe(false);
    },
  );
});
