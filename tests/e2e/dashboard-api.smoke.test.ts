// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../apps/web/src/App.js";
import { buildApiServer } from "../../services/api/src/server.js";
import { createFixtureRuntime } from "../../services/api/src/fixture-runtime.js";

const fixtureToken = "accesshold-local-demo-token";
let originalFetch: typeof globalThis.fetch;
let originalFixtureToken: string | undefined;
let originalTravelerId: string | undefined;
let app: Awaited<ReturnType<typeof buildApiServer>> | undefined;
let requestedRoutes: Array<{
  method: string;
  url: string;
  authorization: string | null;
}>;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  originalFixtureToken = process.env.ACCESSHOLD_FIXTURE_TOKEN;
  originalTravelerId = process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID;
  process.env.ACCESSHOLD_FIXTURE_TOKEN = fixtureToken;
  delete process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID;
  requestedRoutes = [];

  const runtime = await createFixtureRuntime();
  app = await buildApiServer(runtime);
  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? `${input.pathname}${input.search}`
          : new URL(input.url).pathname;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requestedRoutes.push({
      method,
      url,
      authorization: headers.get("authorization"),
    });
    const response = await app!.inject({
      method: method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      url,
      headers: Object.fromEntries(headers.entries()),
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      json: async () => response.json(),
    } as Response;
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  cleanup();
  if (app) await app.close();
  app = undefined;
  globalThis.fetch = originalFetch;
  if (originalFixtureToken === undefined)
    delete process.env.ACCESSHOLD_FIXTURE_TOKEN;
  else process.env.ACCESSHOLD_FIXTURE_TOKEN = originalFixtureToken;
  if (originalTravelerId === undefined)
    delete process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID;
  else process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID = originalTravelerId;
});

describe("coordinator dashboard + Fastify /api/v1 smoke flow", () => {
  it("loads a trip, reviews a disruption, creates a recovery plan, and records explicit approval", async () => {
    const user = userEvent.setup();
    render(createElement(App));

    expect(
      await screen.findByRole("heading", { name: "Trips and change queue" }),
    ).toBeTruthy();
    expect(screen.getByText(/TEST PROVIDER · LOCAL FIXTURE/)).toBeTruthy();
    expect(requestedRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", url: "/api/v1/trips" }),
        expect.objectContaining({
          method: "GET",
          url: expect.stringMatching(/^\/api\/v1\/trips\//),
        }),
        expect.objectContaining({
          method: "GET",
          url: expect.stringMatching(/^\/api\/v1\/cases\//),
        }),
      ]),
    );
    expect(
      requestedRoutes.every(
        (request) => request.authorization === `Bearer ${fixtureToken}`,
      ),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: /Review disruption/ }));
    expect(
      await screen.findByRole("heading", {
        name: "A room detail needs review",
      }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /Review recovery options/ }),
    );
    expect(
      await screen.findByRole("heading", { name: "Review recovery options" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("radio"));
    await user.click(
      screen.getByRole("button", { name: /Review selected recovery/ }),
    );
    expect(await screen.findByText("Pending your approval")).toBeTruthy();
    expect(
      requestedRoutes.some(
        (request) =>
          request.method === "POST" &&
          /^\/api\/v1\/cases\/[^/]+\/options$/.test(request.url),
      ),
    ).toBe(true);

    await user.type(
      screen.getByLabelText(/Type APPROVE RECOVERY/),
      "APPROVE RECOVERY",
    );
    await user.click(
      screen.getByRole("button", { name: "Approve exact plan" }),
    );
    expect(await screen.findByText("Approval recorded")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Execute fixture action" }),
    );
    expect(
      await screen.findByText("Waiting for provider confirmation"),
    ).toBeTruthy();
    expect(screen.getByText(/Acceptance is not confirmation/)).toBeTruthy();

    await waitFor(() => {
      expect(
        requestedRoutes.some(
          (request) =>
            request.method === "POST" &&
            /^\/api\/v1\/plans\/[a-f0-9]{64}\/approvals$/.test(request.url),
        ),
      ).toBe(true);
      expect(
        requestedRoutes.some(
          (request) =>
            request.method === "POST" &&
            /^\/api\/v1\/plans\/[a-f0-9]{64}\/execute$/.test(request.url),
        ),
      ).toBe(true);
    });
    expect(
      requestedRoutes.some((request) => request.url.includes("/api/v1/")),
    ).toBe(true);
  });
});
