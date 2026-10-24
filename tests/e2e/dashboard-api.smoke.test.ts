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
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-contrast");
  document.documentElement.removeAttribute("data-reduced-motion");
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
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-contrast");
  document.documentElement.removeAttribute("data-reduced-motion");
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
      screen.getByRole("status", { name: "Recovery plan updates" }).textContent,
    ).toContain("A pending plan is ready");
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

  it("supports skip-link navigation and exposes named screen-reader landmarks", async () => {
    const user = userEvent.setup();
    render(createElement(App));

    await screen.findByRole("heading", { name: "Trips and change queue" });
    const skipLink = screen.getByRole("link", {
      name: "Skip to main content",
    });
    await user.tab();
    expect(document.activeElement).toBe(skipLink);
    await user.keyboard("{Enter}");

    const main = screen.getByRole("main");
    expect(document.activeElement).toBe(main);
    expect(window.location.hash).toBe("#main");
    expect(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).toBeTruthy();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });

  it("toggles persistent high contrast with a keyboard-trapped preferences dialog", async () => {
    const user = userEvent.setup();
    const view = render(createElement(App));
    await screen.findByRole("heading", { name: "Trips and change queue" });

    const preferencesButton = screen.getByRole("button", {
      name: "Accessibility preferences",
    });
    for (let tabCount = 0; tabCount < 6; tabCount += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(preferencesButton);
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", {
      name: "Accessibility preferences",
    });
    const highContrastSwitch = screen.getByRole("switch", {
      name: "High contrast mode",
    });
    const reduceMotionSwitch = screen.getByRole("switch", {
      name: "Reduce motion",
    });
    const closeButton = screen.getByRole("button", {
      name: "Close accessibility preferences",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(highContrastSwitch),
    );
    const workspace = document.querySelector(".workspace");
    expect(workspace?.getAttribute("aria-hidden")).toBe("true");
    expect(workspace?.hasAttribute("inert")).toBe(true);

    await user.keyboard(" ");
    await waitFor(() => {
      expect(document.documentElement.dataset.contrast).toBe("high");
      expect((highContrastSwitch as HTMLInputElement).checked).toBe(true);
    });
    expect(
      window.localStorage.getItem("accesshold.accessibility.preferences.v1"),
    ).toContain('"highContrast":true');

    await user.tab();
    expect(document.activeElement).toBe(reduceMotionSwitch);
    await user.keyboard(" ");
    await waitFor(() => {
      expect(document.documentElement.dataset.reducedMotion).toBe("reduce");
      expect((reduceMotionSwitch as HTMLInputElement).checked).toBe(true);
    });
    expect(
      window.localStorage.getItem("accesshold.accessibility.preferences.v1"),
    ).toContain('"reduceMotion":true');

    await user.tab();
    expect(document.activeElement).toBe(closeButton);
    await user.tab();
    expect(document.activeElement).toBe(highContrastSwitch);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(closeButton);

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Accessibility preferences" }),
      ).toBeNull();
      expect(document.activeElement).toBe(preferencesButton);
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    view.unmount();
    render(createElement(App));
    await screen.findByRole("heading", { name: "Trips and change queue" });
    expect(document.documentElement.dataset.contrast).toBe("high");
    expect(document.documentElement.dataset.reducedMotion).toBe("reduce");
    await user.click(
      screen.getByRole("button", { name: "Accessibility preferences" }),
    );
    expect(
      (
        (await screen.findByRole("switch", {
          name: "High contrast mode",
        })) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        (await screen.findByRole("switch", {
          name: "Reduce motion",
        })) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("announces provider-question status changes in its live region", async () => {
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole("heading", { name: "Trips and change queue" });

    await user.click(screen.getByRole("button", { name: /Access Contract/ }));
    await screen.findByRole("heading", { name: "Review your Access Contract" });
    await user.click(screen.getByRole("button", { name: "Draft question" }));
    await screen.findByRole("button", {
      name: "Approve this exact message and send",
    });
    expect(
      screen.getByRole("status", { name: "Provider question status" })
        .textContent,
    ).toContain("draft ready for review");

    await user.click(
      screen.getByRole("button", {
        name: "Approve this exact message and send",
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("status", { name: "Provider question status" })
          .textContent,
      ).toContain("no provider confirmation has been received");
    });
  });

  it("switches between the video walkthrough and live coordinator sandbox", async () => {
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole("heading", { name: "Trips and change queue" });

    await user.click(
      screen.getByRole("button", { name: /Watch Video Walkthrough/ }),
    );
    expect(
      screen.getByRole("heading", { name: "Watch the video walkthrough" }),
    ).toBeTruthy();
    const video = screen.getByLabelText(
      "AccessHold demo walkthrough with English captions",
    );
    expect(video.getAttribute("src")).toBe("./media/accesshold-demo.webm");
    expect(
      video.querySelector('track[kind="captions"]')?.getAttribute("src"),
    ).toBe("./media/accesshold-demo.en.vtt");
    expect(
      video.querySelector('track[kind="chapters"]')?.getAttribute("src"),
    ).toBe("./media/accesshold-demo.chapters.vtt");
    expect(
      screen.getByRole("button", { name: "1: High Contrast" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "2: Delay Notification" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "3: Recovery Plan Approval" }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: /Live Coordinator Sandbox/ }),
    );
    expect(
      await screen.findByRole("heading", { name: "Trips and change queue" }),
    ).toBeTruthy();
  });
});
