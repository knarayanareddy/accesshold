import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureRuntime,
  type FixtureRuntime,
} from "../../services/api/src/fixture-runtime.js";
import { createAccessHoldMcpServer } from "../../services/mcp/src/accesshold-mcp-server.js";

const clients: Client[] = [];
const servers: ReturnType<typeof createAccessHoldMcpServer>[] = [];
const transports: InMemoryTransport[] = [];

async function connect(
  runtime: FixtureRuntime,
  actor = runtime.actorTravelerId,
) {
  const server = createAccessHoldMcpServer(runtime, () => actor);
  const client = new Client({
    name: "accesshold-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  servers.push(server);
  clients.push(client);
  transports.push(clientTransport, serverTransport);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function structured<T>(result: unknown): T {
  if (
    typeof result !== "object" ||
    result === null ||
    !("structuredContent" in result) ||
    !result.structuredContent ||
    typeof result.structuredContent !== "object"
  ) {
    throw new Error("tool_structured_content_missing");
  }
  return result.structuredContent as T;
}

describe("AccessHold MCP tools and rich-card resources", () => {
  afterEach(async () => {
    await Promise.all(
      clients.splice(0).map((client) => client.close().catch(() => undefined)),
    );
    await Promise.all(
      servers.splice(0).map((server) => server.close().catch(() => undefined)),
    );
    await Promise.all(
      transports
        .splice(0)
        .map((transport) => transport.close().catch(() => undefined)),
    );
  });

  it("advertises the required traveler-scoped tools", async () => {
    const runtime = await createFixtureRuntime();
    const client = await connect(runtime);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "watch_trip",
        "get_trip_status",
        "get_evidence",
        "list_recovery_options",
        "select_recovery_option",
        "approve_recovery",
        "request_human_handoff",
        "stop_monitoring",
      ]),
    );
    expect(
      tools.find((tool) => tool.name === "approve_recovery")?.inputSchema,
    ).toMatchObject({
      required: ["plan_id", "plan_sha256", "approval_phrase"],
    });
  });

  it("returns status and evidence metadata without provider source URIs", async () => {
    const runtime = await createFixtureRuntime();
    const client = await connect(runtime);
    const statusResult = await client.callTool({
      name: "get_trip_status",
      arguments: { trip_id: runtime.demoTripId },
    });
    const status = structured<{
      status: string;
      hard_constraint_counts: { violated: number };
      changed_assets: Array<{ asset_version: number }>;
    }>(statusResult);
    expect(status.status).toBe("violated");
    expect(status.hard_constraint_counts.violated).toBe(1);
    expect(status.changed_assets[0]?.asset_version).toBe(1);

    const evidenceResult = await client.callTool({
      name: "get_evidence",
      arguments: {
        trip_id: runtime.demoTripId,
        constraint_id: "01000000000000000000000005",
      },
    });
    const evidenceJson = JSON.stringify(evidenceResult.structuredContent);
    expect(evidenceJson).not.toContain("source_uri");
    expect(evidenceJson).not.toContain("provider.example.test");
    expect(evidenceJson).toContain("hotel.room.roll_in_shower");
  });

  it("requires a current-version selection and explicit exact-hash approval before a fixture action", async () => {
    const runtime = await createFixtureRuntime();
    const client = await connect(runtime);
    const optionsResult = await client.callTool({
      name: "list_recovery_options",
      arguments: { case_id: runtime.demoCaseId },
    });
    const options = structured<{
      options: Array<{ option_id: string; unknowns: string[] }>;
    }>(optionsResult);
    expect(options.options[0]?.option_id).toBe(runtime.demoOptionId);
    expect(options.options[0]?.unknowns).toHaveLength(1);

    const selectedResult = await client.callTool({
      name: "select_recovery_option",
      arguments: {
        case_id: runtime.demoCaseId,
        option_id: runtime.demoOptionId,
        expected_version: 2,
      },
    });
    const selected = structured<{ plan_id: string; plan_sha256: string }>(
      selectedResult,
    );
    expect(selected.plan_id).toBe(selected.plan_sha256);

    const rejected = await client.callTool({
      name: "approve_recovery",
      arguments: {
        plan_id: selected.plan_id,
        plan_sha256: selected.plan_sha256,
        approval_phrase: "yes",
      },
    });
    expect(rejected.isError).toBe(true);

    const approvalResult = await client.callTool({
      name: "approve_recovery",
      arguments: {
        plan_id: selected.plan_id,
        plan_sha256: selected.plan_sha256,
        approval_phrase: "APPROVE RECOVERY",
      },
    });
    const approval = structured<{
      status: string;
      provider_notice: string;
      execution_task_id: string | null;
    }>(approvalResult);
    expect(approval.status).toBe("executed_fixture");
    expect(approval.execution_task_id).toMatch(/^TEST-/);
    expect(approval.provider_notice).toContain("no live booking changed");
  });

  it("creates a not-sent human handoff and stops monitoring with explicit status", async () => {
    const runtime = await createFixtureRuntime();
    const client = await connect(runtime);
    const handoffResult = await client.callTool({
      name: "request_human_handoff",
      arguments: { case_id: runtime.demoCaseId, callback_preference: "email" },
    });
    const handoff = structured<{ status: string }>(handoffResult);
    expect(handoff.status).toBe("fixture_packet_ready_not_sent");

    const stoppedResult = await client.callTool({
      name: "stop_monitoring",
      arguments: { trip_id: runtime.demoTripId, expected_version: 2 },
    });
    const stopped = structured<{
      status: string;
      monitoring_authorized: boolean;
    }>(stoppedResult);
    expect(stopped).toMatchObject({
      status: "closed",
      monitoring_authorized: false,
    });
  });

  it("denies cross-traveler access before returning trip data", async () => {
    const runtime = await createFixtureRuntime();
    const client = await connect(runtime, "01000000000000000000000099");
    const result = await client.callTool({
      name: "get_trip_status",
      arguments: { trip_id: runtime.demoTripId },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Fixture Hotel Provider");
  });
});
