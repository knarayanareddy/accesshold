import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../apps/web/src/api.js";
import { createSandboxApiAdapter } from "../../apps/web/src/sandbox-api.js";
import { createFixtureRuntime } from "../../services/api/src/fixture-runtime.js";

interface TripListResponse {
  trips: Array<{ trip_id: string; provenance: "fixture" }>;
}

interface RecoveryOptionsResponse {
  option_set_version: number;
  options: Array<{ option_id: string }>;
}

interface PlanResponse {
  plan_id: string;
  plan_sha256: string;
  plan: { state: string };
}

interface ApprovalResponse {
  approval: { approval_id: string };
}

interface ExecutionResponse {
  receipt: { provider: string; live_action: boolean; status: string };
}

describe("standalone fixture sandbox API", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("dispatches VITE_SANDBOX requests without fetching a live backend", async () => {
    vi.stubEnv("VITE_SANDBOX", "true");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const trips = await apiRequest<TripListResponse>("/api/v1/trips");

    expect(trips.trips.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the in-memory fixture services for a plan-bound approved demo action", async () => {
    const runtime = await createFixtureRuntime();
    const request = createSandboxApiAdapter(runtime);
    const trips = await request<TripListResponse>("/api/v1/trips");
    expect(trips.trips).toEqual([
      expect.objectContaining({
        trip_id: runtime.demoTripId,
        provenance: "fixture",
      }),
    ]);

    const options = await request<RecoveryOptionsResponse>(
      `/api/v1/cases/${runtime.demoCaseId}/options`,
    );
    expect(options.options).toHaveLength(1);
    const plan = await request<PlanResponse>(
      `/api/v1/cases/${runtime.demoCaseId}/options`,
      {
        method: "POST",
        body: JSON.stringify({
          option_id: runtime.demoOptionId,
          expected_version: options.option_set_version,
        }),
      },
    );
    expect(plan.plan_id).toBe(plan.plan_sha256);
    expect(plan.plan.state).toBe("options_ready");

    const approval = await request<ApprovalResponse>(
      `/api/v1/plans/${plan.plan_id}/approvals`,
      {
        method: "POST",
        body: JSON.stringify({
          plan_sha256: plan.plan_sha256,
          approval_phrase: "APPROVE RECOVERY",
        }),
      },
    );
    expect(approval.approval.approval_id).toBeTruthy();

    const execution = await request<ExecutionResponse>(
      `/api/v1/plans/${plan.plan_id}/execute`,
      {
        method: "POST",
        body: JSON.stringify({ plan_sha256: plan.plan_sha256 }),
      },
    );
    expect(execution.receipt).toMatchObject({
      provider: "TEST PROVIDER",
      live_action: false,
      status: "test_change_recorded",
    });
  });

  it("routes provider-question approval to the versioned fixture adapter", async () => {
    const runtime = await createFixtureRuntime();
    const request = createSandboxApiAdapter(runtime);
    const view = await runtime.contracts.getTrip(
      runtime.demoTripId,
      runtime.actorTravelerId,
    );
    const constraint = view.contract.constraints.find(
      (item) => item.applies_to.length > 0,
    );
    expect(constraint).toBeDefined();

    const drafted = await request<{
      draft: {
        request_id: string;
        contract_version: number;
        approval_hash: string;
      };
    }>(`/api/v1/trips/${runtime.demoTripId}/provider-questions`, {
      method: "POST",
      body: JSON.stringify({
        expected_contract_version: view.contract.version,
        constraint_id: constraint!.constraint_id,
        asset_id: constraint!.applies_to[0],
        recipient: "access@example.invalid",
        idempotency_key: "sandbox-question-test",
      }),
    });
    const sent = await request<{
      receipt: {
        provider: string;
        live_send: boolean;
        provider_confirmation_received: boolean;
      };
    }>(`/api/v1/provider-questions/${drafted.draft.request_id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        expected_contract_version: drafted.draft.contract_version,
        approval_hash: drafted.draft.approval_hash,
      }),
    });

    expect(sent.receipt).toMatchObject({
      provider: "TEST PROVIDER",
      live_send: false,
      provider_confirmation_received: false,
    });
  });
});
