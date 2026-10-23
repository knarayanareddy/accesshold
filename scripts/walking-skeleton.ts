import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  FixtureReferenceTravelAdapter,
  type ReferenceTravelChange,
} from "../packages/adapters/reference-travel/src/index.js";
import type { AccessContractDocument } from "../packages/contracts/src/index.js";
import type { FeatureRegistry } from "../packages/policy-engine/src/index.js";
import { JsonFileFixtureContractRepository } from "../services/importer/src/contract-repository.js";
import { ManualContractService } from "../services/importer/src/manual-contract-service.js";
import { ReferenceTravelMonitor } from "../services/monitor/src/reference-travel-monitor.js";
import { FixtureRecoveryService } from "../services/recovery/src/fixture-recovery-service.js";
import {
  FixtureCalendarService,
  FixtureHandoffService,
} from "../services/workflow/src/fixture-workflow-service.js";

function readJson<T>(relative: string): T {
  return JSON.parse(
    readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"),
  ) as T;
}

const schema = readJson<object>("schemas/access-contract.schema.json");
const registry = readJson<FeatureRegistry>("content/feature-registry/v1.json");
const example = readJson<AccessContractDocument>(
  "examples/access-contract.example.json",
);
const clock = () => new Date("2026-10-23T12:00:00.000Z");

function referenceChange(
  externalId: string,
  sequence: number,
  rollInShower: boolean,
): ReferenceTravelChange {
  const asset = structuredClone(example.assets[0]!);
  asset.provider_reference = `TEST-${externalId.toUpperCase()}`;
  asset.attributes[0]!.value = rollInShower;
  const evidence = structuredClone(example.evidence[0]!);
  evidence.verification_level = "documented";
  evidence.features[0]!.value = rollInShower;
  evidence.observed_at = "2026-10-23T11:00:00.000Z";
  evidence.content_sha256 = createHash("sha256")
    .update(`${externalId}:${rollInShower}`)
    .digest("hex");
  return {
    external_id: externalId,
    trip_id: example.trip.trip_id,
    asset_id: example.assets[0]!.asset_id,
    sequence,
    asset,
    evidence,
  };
}

const directory = await mkdtemp(join(tmpdir(), "accesshold-walking-"));

try {
  const path = join(directory, "fixture-contracts.json");
  const repository = new JsonFileFixtureContractRepository(path);
  const service = new ManualContractService(
    schema,
    registry,
    repository,
    clock,
  );
  const draft: AccessContractDocument = {
    ...structuredClone(example),
    status: "draft",
    trip: { ...structuredClone(example.trip), source: "manual" },
    version: 1,
    updated_at: example.created_at,
  };
  const actor = draft.traveler_id;
  const tripId = draft.trip.trip_id;
  const imported = await service.importManual(draft, actor);
  const activated = await service.activate({
    tripId,
    actorTravelerId: actor,
    expectedVersion: 1,
    approvedContractVersion: 1,
  });
  const adapter = new FixtureReferenceTravelAdapter([
    referenceChange("violation", 1, false),
    referenceChange("recovery", 2, true),
  ]);
  const monitor = new ReferenceTravelMonitor(
    schema,
    registry,
    repository,
    adapter,
    clock,
  );
  const violationPage = await monitor.pollFixtureOnce({
    tripId,
    actorTravelerId: actor,
    cursor: null,
    limit: 1,
  });
  const violation = violationPage.results[0]!;
  if (!violation.recovery_case)
    throw new Error("Fixture violation case is required");
  const recovery = new FixtureRecoveryService(clock, [
    violation.affected_asset,
  ]);
  const offered = recovery.offerPlans({
    document: violation.contract,
    caseId: violation.recovery_case.case_id,
    options: [
      {
        option_id: "fixture-hotel-recovery",
        summary: "TEST replacement room with the required fixture feature.",
        action: "sandbox_rebook",
        asset_id: violation.affected_asset.asset_id,
        asset_version: violation.affected_asset.asset_version,
        evidence_id: violation.affected_asset.evidence_id,
        evidence_version: violation.affected_asset.evidence_version,
        replacement_provider_reference: "TEST-RECOVERY-ROOM",
        amount_minor: 0,
        currency: "EUR",
        terms: "Fixture terms only; no live inventory or booking.",
        inventory_token: "fixture-room-inventory-v1",
        expires_at: "2026-10-23T12:30:00.000Z",
        unknowns: ["Independent replacement confirmation is required."],
      },
    ],
  });
  const plan = offered.plans[0]!;
  const approval = recovery.approve({
    document: violation.contract,
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
  const duplicateExecution = recovery.execute({
    approvalPlanHash: approval.plan_hash,
    submittedPlanHash: plan.plan_hash,
    actorTravelerId: actor,
  });
  const recoveryPage = await monitor.pollFixtureOnce({
    tripId,
    actorTravelerId: actor,
    cursor: violationPage.next_cursor,
    limit: 1,
  });
  const recovered = recoveryPage.results[0]!;
  const confirmation = recovery.importConfirmation({
    planHash: plan.plan_hash,
    actorTravelerId: actor,
    contractVersion: recovered.contract.version,
    confirmationSha256: createHash("sha256")
      .update("walking-fixture-replacement-confirmation")
      .digest("hex"),
    allHardConstraintsSatisfiedOrNotApplicable:
      recovered.evaluation.status === "active",
  });
  const handoffService = new FixtureHandoffService(clock);
  const handoff = handoffService.requestHandoff({
    document: recovered.contract,
    caseId: violation.recovery_case.case_id,
    actorTravelerId: actor,
    reason: "Traveler requested human review of the fixture recovery evidence.",
    plan: confirmation.plan,
    receipt: execution.receipt,
  });
  const duplicateHandoff = handoffService.requestHandoff({
    document: recovered.contract,
    caseId: violation.recovery_case.case_id,
    actorTravelerId: actor,
    reason: "Traveler requested human review of the fixture recovery evidence.",
    plan: confirmation.plan,
    receipt: execution.receipt,
  });
  const calendarService = new FixtureCalendarService(clock);
  const calendar = calendarService.updateConfirmedItinerary({
    document: recovered.contract,
    completedPlan: confirmation.plan,
    actorTravelerId: actor,
    externalEventId: "fixture-calendar-event-1",
    requestId: "fixture-calendar-request-1",
  });
  const duplicateCalendar = calendarService.updateConfirmedItinerary({
    document: recovered.contract,
    completedPlan: confirmation.plan,
    actorTravelerId: actor,
    externalEventId: "fixture-calendar-event-1",
    requestId: "fixture-calendar-request-retry",
  });
  const monitoredResults = [...violationPage.results, ...recoveryPage.results];
  const recoveryCases = await monitor.cases(tripId, actor);
  const assetVersions = await monitor.assetHistory(
    tripId,
    example.assets[0]!.asset_id,
    actor,
  );

  const reopened = new ManualContractService(
    schema,
    registry,
    new JsonFileFixtureContractRepository(path),
    clock,
  );
  const restored = await reopened.getTrip(tripId, actor);
  const history = await reopened.versionHistory(tripId, actor);
  console.log(
    JSON.stringify(
      {
        mode: "FIXTURE ONLY — no travel provider, SES, AWS, Alexa+, or monitoring worker connection",
        trip: restored.contract.trip.title,
        imported_status: imported.contract.status,
        activated_status: activated.contract.status,
        restored_version: restored.contract.version,
        persisted_versions: history.length,
        monitoring_authorized: restored.monitoring_authorized,
        monitoring_worker_running: false,
        reference_travel: adapter.capabilities(),
        monitored_statuses: monitoredResults.map(
          (result) => result.contract.status,
        ),
        recovery_case_state: recoveryCases[0]?.state,
        recovery_timeline: recoveryCases[0]?.timeline.map(
          (entry) => entry.code,
        ),
        immutable_asset_versions: assetVersions.map((item) => item.version),
        recovery_no_action_option: offered.no_action.option_id,
        recovery_approval_method: approval.method,
        recovery_plan_state: confirmation.plan.state,
        recovery_receipt_status: execution.receipt.status,
        recovery_receipt_duplicate_safe:
          duplicateExecution.duplicate && recovery.receiptCount === 1,
        recovery_live_action: execution.receipt.live_action,
        handoff_packet_id: handoff.packet.packet_id,
        handoff_duplicate_safe:
          duplicateHandoff.duplicate && handoffService.packetCount === 1,
        handoff_live_handoff: handoff.packet.live_handoff,
        calendar_update_status: calendar.update.status,
        calendar_update_duplicate_safe:
          duplicateCalendar.duplicate && calendarService.updateCount === 1,
        calendar_external_update: calendar.update.external_update,
        fixture_recovery_executor:
          "Separate TEST PROVIDER outbox; not a ReferenceTravelAdapter rebooking capability",
        test_provider_notice: monitoredResults[0]?.provider_notice,
        provenance: restored.provenance,
        notice:
          "Fixture plan approval, TEST PROVIDER outbox, synthetic replacement confirmation, human-handoff packet, and calendar intent only; no live provider, external recovery action, monitoring worker, external calendar update, or physical accessibility guarantee is claimed.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
