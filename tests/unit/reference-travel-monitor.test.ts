import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  FixtureReferenceTravelAdapter,
  type ReferenceTravelChange,
} from "../../packages/adapters/reference-travel/src/index.js";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import type { FeatureRegistry } from "../../packages/policy-engine/src/index.js";
import { InMemoryContractRepository } from "../../services/importer/src/contract-repository.js";
import { ManualContractService } from "../../services/importer/src/manual-contract-service.js";
import { ReferenceTravelMonitor } from "../../services/monitor/src/reference-travel-monitor.js";

function readJson<T>(relative: string): T {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../${relative}`, import.meta.url)),
      "utf8",
    ),
  ) as T;
}

const schema = readJson<object>("schemas/access-contract.schema.json");
const registry = readJson<FeatureRegistry>("content/feature-registry/v1.json");
const example = readJson<AccessContractDocument>(
  "examples/access-contract.example.json",
);
const actor = example.traveler_id;
const tripId = example.trip.trip_id;
const assetId = example.assets[0]!.asset_id;
const evidenceId = example.evidence[0]!.evidence_id;
const clock = () => new Date("2026-10-23T12:00:00.000Z");

function draft(): AccessContractDocument {
  return {
    ...structuredClone(example),
    status: "draft",
    trip: { ...structuredClone(example.trip), source: "manual" },
    version: 1,
    updated_at: example.created_at,
  };
}

function change(
  externalId: string,
  sequence: number,
  value: boolean | null,
  reference = `TEST-${externalId.toUpperCase()}`,
): ReferenceTravelChange {
  const asset = structuredClone(example.assets[0]!);
  asset.provider_reference = reference;
  asset.attributes[0]!.value = value;
  const evidence = structuredClone(example.evidence[0]!);
  evidence.verification_level = "documented";
  evidence.features[0]!.value = value;
  evidence.observed_at = "2026-10-23T11:00:00.000Z";
  evidence.content_sha256 = createHash("sha256")
    .update(`${externalId}:${String(value)}`)
    .digest("hex");
  evidence.source_uri = `https://reference-travel.example.test/changes/${externalId}`;
  return {
    external_id: externalId,
    trip_id: tripId,
    asset_id: assetId,
    sequence,
    asset,
    evidence,
  };
}

async function activeMonitor(
  repository = new InMemoryContractRepository(),
  adapter = new FixtureReferenceTravelAdapter([]),
) {
  const contracts = new ManualContractService(
    schema,
    registry,
    repository,
    clock,
  );
  await contracts.importManual(draft(), actor);
  await contracts.activate({
    tripId,
    actorTravelerId: actor,
    expectedVersion: 1,
    approvedContractVersion: 1,
  });
  const monitor = new ReferenceTravelMonitor(
    schema,
    registry,
    repository,
    adapter,
    clock,
  );
  return { monitor, repository };
}

describe("ReferenceTravel fixture monitoring and recovery", () => {
  it("deduplicates changes, preserves versions, and records one recovery timeline", async () => {
    const { monitor, repository } = await activeMonitor();
    const safe = change("safe", 1, true);
    const safeResult = await monitor.ingest(safe, actor);
    expect(safeResult.contract.status).toBe("active");
    expect(safeResult.recovery_case).toBeUndefined();
    expect(safeResult.affected_asset.asset_version).toBe(1);

    const violated = change("violation", 2, false);
    const violationResult = await monitor.ingest(violated, actor);
    expect(violationResult.contract.status).toBe("violated");
    expect(violationResult.recovery_case?.state).toBe("detected");
    expect(violationResult.recovery_case?.version).toBe(1);
    const caseId = violationResult.recovery_case!.case_id;

    const duplicate = await monitor.ingest(violated, actor);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.contract.version).toBe(4);
    expect(
      (await repository.versions(tripId)).map((item) => item.version),
    ).toEqual([1, 2, 3, 4]);
    const conflictingReplay = structuredClone(violated);
    conflictingReplay.evidence.features[0]!.value = true;
    await expect(monitor.ingest(conflictingReplay, actor)).rejects.toThrow(
      "provider_event_replay_conflict",
    );

    const equivalent = change(
      "equivalent",
      3,
      false,
      violated.asset.provider_reference,
    );
    equivalent.asset = structuredClone(violated.asset);
    equivalent.evidence = structuredClone(violated.evidence);
    const attached = await monitor.ingest(equivalent, actor);
    expect(attached.disposition).toBe("equivalent");
    expect(attached.contract.version).toBe(4);
    expect(attached.affected_asset.asset_version).toBe(2);
    expect(attached.recovery_case?.timeline.map((entry) => entry.code)).toEqual(
      ["violation_detected", "equivalent_change_attached"],
    );

    const stale = change("stale", 2, true);
    const staleResult = await monitor.ingest(stale, actor);
    expect(staleResult.disposition).toBe("stale");
    expect(staleResult.contract.status).toBe("violated");
    expect(staleResult.contract.version).toBe(4);
    const sequenceConflict = change("sequence-conflict", 3, true);
    await expect(monitor.ingest(sequenceConflict, actor)).rejects.toThrow(
      "provider_sequence_conflict",
    );

    const recovered = await monitor.ingest(change("recovery", 4, true), actor);
    expect(recovered.contract.status).toBe("active");
    expect(recovered.contract.constraints[0]!.status).toBe("documented");
    expect(recovered.recovery_case).toMatchObject({
      case_id: caseId,
      state: "completed",
      version: 3,
    });
    expect(
      recovered.recovery_case?.timeline.map((entry) => entry.code),
    ).toEqual([
      "violation_detected",
      "equivalent_change_attached",
      "recovery_completed",
    ]);

    const assets = await monitor.assetHistory(tripId, assetId, actor);
    expect(assets.map((item) => item.version)).toEqual([0, 1, 2, 3]);
    expect(assets.map((item) => item.asset.provider_reference)).toEqual([
      "TEST-CONF-001",
      "TEST-SAFE",
      "TEST-VIOLATION",
      "TEST-RECOVERY",
    ]);
    const evidence = await monitor.evidenceHistory(tripId, evidenceId, actor);
    expect(evidence.map((item) => item.version)).toEqual([0, 1, 2, 3]);
    assets[0]!.asset.provider_reference = "MUTATED-RETURN-VALUE";
    expect(
      (await monitor.assetHistory(tripId, assetId, actor))[0]!.asset
        .provider_reference,
    ).toBe("TEST-CONF-001");

    const secondViolation = await monitor.ingest(
      change("second-violation", 5, false),
      actor,
    );
    expect(secondViolation.recovery_case?.case_id).not.toBe(caseId);
    const cases = await monitor.cases(tripId, actor);
    expect(cases).toHaveLength(2);
    expect(cases[0]?.state).toBe("completed");
    expect(cases[0]?.timeline).toHaveLength(3);
  });

  it("keeps unknown recovery evidence open and completes only after satisfied revalidation", async () => {
    const { monitor } = await activeMonitor();
    await monitor.ingest(change("violation", 1, false), actor);
    const degraded = await monitor.ingest(change("unknown", 2, null), actor);
    expect(degraded.contract.status).toBe("degraded");
    expect(degraded.recovery_case?.state).toBe("detected");
    expect(degraded.recovery_case?.timeline.at(-1)?.code).toBe(
      "recovery_degraded",
    );
    const recovered = await monitor.ingest(change("recovery", 3, true), actor);
    expect(recovered.recovery_case?.state).toBe("completed");
    expect(
      recovered.recovery_case?.timeline.map((entry) => entry.code),
    ).toEqual([
      "violation_detected",
      "recovery_degraded",
      "recovery_completed",
    ]);
  });

  it("pages fixture changes explicitly without claiming live capabilities", async () => {
    const safe = change("safe", 1, true);
    const next = change("next", 2, true);
    const adapter = new FixtureReferenceTravelAdapter([next, safe]);
    expect(adapter.capabilities()).toEqual({
      changeEvents: true,
      readStatus: false,
      readInventory: false,
      sandboxRebook: false,
      live: false,
      testProvider: true,
    });
    const { monitor, repository } = await activeMonitor(
      new InMemoryContractRepository(),
      adapter,
    );
    const first = await monitor.pollFixtureOnce({
      tripId,
      actorTravelerId: actor,
      cursor: null,
      limit: 1,
    });
    expect(first.results[0]?.external_id).toBe("safe");
    expect(first.next_cursor).toBe("safe");
    const second = await monitor.pollFixtureOnce({
      tripId,
      actorTravelerId: actor,
      cursor: first.next_cursor,
      limit: 1,
    });
    expect(second.results[0]?.external_id).toBe("next");
    expect(second.next_cursor).toBeNull();
    expect(await repository.versions(tripId)).toHaveLength(4);

    const replayed = await monitor.pollFixtureOnce({
      tripId,
      actorTravelerId: actor,
      cursor: null,
      limit: 1,
    });
    expect(replayed.results[0]?.duplicate).toBe(true);
    expect(await repository.versions(tripId)).toHaveLength(4);
    await expect(
      adapter.fetchChanges({ tripId, cursor: "missing", limit: 1 }),
    ).rejects.toThrow("invalid_fixture_cursor");
  });

  it("does not commit histories or cases when the contract append fails", async () => {
    const repository = new InMemoryContractRepository();
    const { monitor } = await activeMonitor(repository);
    const append = vi
      .spyOn(repository, "append")
      .mockRejectedValueOnce(new Error("fixture_write_failed"));
    const disruption = change("violation", 1, false);
    await expect(monitor.ingest(disruption, actor)).rejects.toThrow(
      "fixture_write_failed",
    );
    expect((await repository.current(tripId))?.version).toBe(2);
    expect(await monitor.cases(tripId, actor)).toEqual([]);
    expect(
      (await monitor.assetHistory(tripId, assetId, actor)).map(
        (item) => item.version,
      ),
    ).toEqual([0]);
    append.mockRestore();
    expect((await monitor.ingest(disruption, actor)).contract.version).toBe(3);
  });

  it("rejects unauthorized, premature, malformed, and live-looking changes", async () => {
    const { monitor, repository } = await activeMonitor();
    const disruption = change("violation", 1, false);
    await expect(monitor.ingest(disruption, "other-traveler")).rejects.toThrow(
      "trip_access_denied",
    );
    const liveLooking = structuredClone(disruption);
    liveLooking.evidence.verification_level = "provider_confirmed";
    await expect(monitor.ingest(liveLooking, actor)).rejects.toThrow(
      "non_live_fixture_evidence",
    );
    const badSequence = structuredClone(disruption);
    badSequence.sequence = 0;
    await expect(monitor.ingest(badSequence, actor)).rejects.toThrow(
      "invalid_reference_travel_sequence",
    );
    const unknownEvidence = structuredClone(disruption);
    unknownEvidence.evidence.evidence_id = "01000000000000000000000099";
    await expect(monitor.ingest(unknownEvidence, actor)).rejects.toThrow(
      "unknown_asset_or_evidence_stream",
    );
    expect((await repository.current(tripId))?.version).toBe(2);

    const draftRepository = new InMemoryContractRepository();
    await new ManualContractService(
      schema,
      registry,
      draftRepository,
      clock,
    ).importManual(draft(), actor);
    const draftMonitor = new ReferenceTravelMonitor(
      schema,
      registry,
      draftRepository,
      new FixtureReferenceTravelAdapter([]),
      clock,
    );
    await expect(draftMonitor.ingest(disruption, actor)).rejects.toThrow(
      "monitoring_not_authorized_for_contract_status",
    );
  });
});
