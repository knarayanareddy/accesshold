import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import {
  FixtureRecoveryService,
  type FixtureRecoveryOption,
} from "../../services/recovery/src/fixture-recovery-service.js";
import {
  FixtureCalendarService,
  FixtureHandoffService,
} from "../../services/workflow/src/fixture-workflow-service.js";

const example = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../examples/access-contract.example.json", import.meta.url),
    ),
    "utf8",
  ),
) as AccessContractDocument;
const actor = example.traveler_id;
const clock = () => new Date("2026-10-23T12:00:00.000Z");

function document(status: AccessContractDocument["status"], version: number) {
  return { ...structuredClone(example), status, version };
}

function option(): FixtureRecoveryOption {
  return {
    option_id: "fixture-handoff-option",
    summary: "TEST replacement with an unresolved human-review item.",
    action: "sandbox_rebook",
    asset_id: example.assets[0]!.asset_id,
    asset_version: 1,
    evidence_id: example.evidence[0]!.evidence_id,
    evidence_version: 1,
    replacement_provider_reference: "TEST-HANDOFF-ROOM",
    amount_minor: 0,
    currency: "EUR",
    terms: "Fixture terms only; no live booking.",
    inventory_token: "fixture-handoff-inventory",
    expires_at: "2026-10-23T12:30:00.000Z",
    unknowns: ["A human must verify the replacement evidence."],
  };
}

function completedFixture() {
  const recovery = new FixtureRecoveryService(clock, [
    {
      asset_id: example.assets[0]!.asset_id,
      asset_version: 1,
      evidence_id: example.evidence[0]!.evidence_id,
      evidence_version: 1,
    },
  ]);
  const violated = document("violated", 4);
  const plan = recovery.offerPlans({
    document: violated,
    caseId: "case-handoff",
    options: [option()],
  }).plans[0]!;
  const approval = recovery.approve({
    document: violated,
    planHash: plan.plan_hash,
    actorTravelerId: actor,
    method: "web",
    recentAuthentication: true,
  });
  const execution = recovery.execute({
    approvalPlanHash: approval.plan_hash,
    submittedPlanHash: plan.plan_hash,
    actorTravelerId: actor,
  });
  const completed = recovery.importConfirmation({
    planHash: plan.plan_hash,
    actorTravelerId: actor,
    contractVersion: 5,
    confirmationSha256: "c".repeat(64),
    allHardConstraintsSatisfiedOrNotApplicable: true,
  });
  return {
    recovery,
    violated,
    plan,
    completedPlan: completed.plan,
    receipt: execution.receipt,
    active: document("active", 5),
  };
}

describe("AccessHold fixture handoff and confirmed-calendar workflow", () => {
  it("builds a complete scoped handoff packet and is retry safe", () => {
    const fixture = completedFixture();
    const service = new FixtureHandoffService(clock);
    const result = service.requestHandoff({
      document: fixture.active,
      caseId: "case-handoff",
      actorTravelerId: actor,
      reason: "Traveler requested a human accessibility review.",
      plan: fixture.completedPlan,
      receipt: fixture.receipt,
    });
    expect(result.duplicate).toBe(false);
    expect(result.packet).toMatchObject({
      case_id: "case-handoff",
      trip_id: example.trip.trip_id,
      contract_version: 5,
      recipient: example.approval_policy.human_handoff_contact,
      provenance: "fixture",
      live_handoff: false,
    });
    expect(result.packet.itinerary.assets).toHaveLength(example.assets.length);
    expect(result.packet.constraints).toEqual(fixture.active.constraints);
    expect(result.packet.evidence).toEqual(fixture.active.evidence);
    expect(result.packet.attempted_actions).toEqual([fixture.receipt]);
    expect(result.packet.unknowns).toContain(
      "A human must verify the replacement evidence.",
    );
    expect(
      service.requestHandoff({
        document: fixture.active,
        caseId: "case-handoff",
        actorTravelerId: actor,
        reason: "Traveler requested a human accessibility review.",
        plan: fixture.completedPlan,
        receipt: fixture.receipt,
      }).duplicate,
    ).toBe(true);
    expect(service.packetCount).toBe(1);
  });

  it("rejects cross-traveler, live, and mismatched handoff bindings", () => {
    const fixture = completedFixture();
    const service = new FixtureHandoffService(clock);
    const request = {
      document: fixture.active,
      caseId: "case-handoff",
      actorTravelerId: actor,
      reason: "Human review requested.",
      plan: fixture.completedPlan,
      receipt: fixture.receipt,
    };
    expect(() =>
      service.requestHandoff({ ...request, actorTravelerId: "other" }),
    ).toThrow("trip_access_denied");
    expect(() =>
      service.requestHandoff({ ...request, caseId: "other-case" }),
    ).toThrow("handoff_plan_binding_mismatch");
    expect(() =>
      service.requestHandoff({
        ...request,
        document: { ...fixture.active, provenance: "live" },
      }),
    ).toThrow("fixture_workflow_document_required");
    const withoutReceipt = {
      document: request.document,
      caseId: request.caseId,
      actorTravelerId: request.actorTravelerId,
      reason: request.reason,
      plan: request.plan,
    };
    expect(() => service.requestHandoff(withoutReceipt)).not.toThrow();
    expect(service.packetCount).toBe(1);
  });

  it("blocks calendar writes before completed confirmation and deduplicates retries", () => {
    const fixture = completedFixture();
    const service = new FixtureCalendarService(clock);
    expect(() =>
      service.updateConfirmedItinerary({
        document: fixture.active,
        completedPlan: fixture.plan,
        actorTravelerId: actor,
        externalEventId: "fixture-event-1",
        requestId: "request-1",
      }),
    ).toThrow("confirmed_itinerary_required_for_calendar_update");
    const result = service.updateConfirmedItinerary({
      document: fixture.active,
      completedPlan: fixture.completedPlan,
      actorTravelerId: actor,
      externalEventId: "fixture-event-1",
      requestId: "request-1",
    });
    expect(result.duplicate).toBe(false);
    expect(result.update).toMatchObject({
      confirmed_contract_version: 5,
      external_event_id: "fixture-event-1",
      external_update: false,
      status: "fixture_update_recorded",
    });
    expect(
      service.updateConfirmedItinerary({
        document: fixture.active,
        completedPlan: fixture.completedPlan,
        actorTravelerId: actor,
        externalEventId: "fixture-event-1",
        requestId: "request-1-retry",
      }).duplicate,
    ).toBe(true);
    expect(service.updateCount).toBe(1);
  });

  it("rejects stale/conflicting versions and permits a newer confirmed itinerary", () => {
    const fixture = completedFixture();
    const service = new FixtureCalendarService(clock);
    const request = {
      document: fixture.active,
      completedPlan: fixture.completedPlan,
      actorTravelerId: actor,
      externalEventId: "fixture-event-1",
      requestId: "request-1",
    };
    service.updateConfirmedItinerary(request);
    expect(() =>
      service.updateConfirmedItinerary({
        ...request,
        externalEventId: "different-event",
      }),
    ).toThrow("conflicting_calendar_update_for_confirmed_version");
    expect(() =>
      service.updateConfirmedItinerary({
        ...request,
        document: document("active", 4),
      }),
    ).toThrow("confirmed_itinerary_required_for_calendar_update");
    const newer = service.updateConfirmedItinerary({
      ...request,
      document: document("active", 6),
      externalEventId: "fixture-event-2",
    });
    expect(newer.duplicate).toBe(false);
    expect(service.updateCount).toBe(2);
    expect(() =>
      service.updateConfirmedItinerary({
        ...request,
        document: document("active", 5),
        externalEventId: "fixture-event-3",
      }),
    ).toThrow("stale_confirmed_itinerary_version");
  });
});
