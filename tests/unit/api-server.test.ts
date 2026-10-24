import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildApiServer } from "../../services/api/src/server.js";
import { createFixtureRuntime } from "../../services/api/src/fixture-runtime.js";

const token = "accesshold-local-demo-token";
const originalToken = process.env.ACCESSHOLD_FIXTURE_TOKEN;
const originalTraveler = process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID;

function authHeaders() {
  return { authorization: `Bearer ${token}` };
}

afterEach(() => {
  if (originalToken === undefined) delete process.env.ACCESSHOLD_FIXTURE_TOKEN;
  else process.env.ACCESSHOLD_FIXTURE_TOKEN = originalToken;
  if (originalTraveler === undefined)
    delete process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID;
  else process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID = originalTraveler;
});

describe("fixture REST API and Streamable HTTP MCP route", () => {
  it("requires the local bearer token and returns owner-scoped trip state", async () => {
    process.env.ACCESSHOLD_FIXTURE_TOKEN = token;
    delete process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID;
    const runtime = await createFixtureRuntime();
    const app = await buildApiServer(runtime);
    try {
      const unauthenticated = await app.inject({
        method: "GET",
        url: "/api/v1/trips",
      });
      expect(unauthenticated.statusCode).toBe(401);

      const trips = await app.inject({
        method: "GET",
        url: "/api/v1/trips",
        headers: authHeaders(),
      });
      expect(trips.statusCode).toBe(200);
      expect(trips.json()).toMatchObject({
        trips: [
          {
            trip_id: runtime.demoTripId,
            status: "violated",
            open_case_count: 1,
            provenance: "fixture",
          },
        ],
      });

      const contract = await app.inject({
        method: "GET",
        url: `/api/v1/trips/${runtime.demoTripId}`,
        headers: authHeaders(),
      });
      expect(contract.statusCode).toBe(200);
      expect(contract.json().contract.version).toBe(2);

      const options = await app.inject({
        method: "GET",
        url: `/api/v1/cases/${runtime.demoCaseId}/options`,
        headers: authHeaders(),
      });
      expect(options.statusCode).toBe(200);
      expect(options.json().options[0].option_id).toBe(runtime.demoOptionId);
    } finally {
      await app.close();
    }
  });

  it("runs MCP initialize, tools/list, and tool calls over Streamable HTTP", async () => {
    process.env.ACCESSHOLD_FIXTURE_TOKEN = token;
    delete process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID;
    const runtime = await createFixtureRuntime();
    const app = await buildApiServer(runtime);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("api_listener_unavailable");
    const client = new Client({
      name: "streamable-http-test-client",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: authHeaders() } },
    );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("get_trip_status");
      const result = await client.callTool({
        name: "get_trip_status",
        arguments: { trip_id: runtime.demoTripId },
      });
      expect(result.structuredContent).toMatchObject({
        trip_id: runtime.demoTripId,
        status: "violated",
        provenance: "fixture",
      });
    } finally {
      await client.close().catch(() => undefined);
      await app.close();
    }
  });
});
