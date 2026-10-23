import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import type { ConstraintCaptureDraft } from "../../packages/domain/src/index.js";
import type { FeatureRegistry } from "../../packages/policy-engine/src/index.js";
import {
  InMemoryContractRepository,
  JsonFileFixtureContractRepository,
  type ContractRepository,
} from "../../services/importer/src/contract-repository.js";
import { ManualContractService } from "../../services/importer/src/manual-contract-service.js";

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
const clock = () => new Date("2026-10-23T12:00:00.000Z");
const temporaryDirectories: string[] = [];

function draft(): AccessContractDocument {
  return {
    ...structuredClone(example),
    status: "draft",
    trip: { ...structuredClone(example.trip), source: "manual" },
    version: 1,
    updated_at: example.created_at,
  };
}
function service(
  repository: ContractRepository = new InMemoryContractRepository(),
  constraintIdFactory: (at: Date) => string = () =>
    "01000000000000000000000007",
): ManualContractService {
  return new ManualContractService(
    schema,
    registry,
    repository,
    clock,
    constraintIdFactory,
  );
}

function constraintDraft(): ConstraintCaptureDraft {
  return {
    traveler_text: "I need a doorway at least 80 cm wide.",
    priority: "hard",
    applies_to: [example.assets[0]!.asset_id],
    predicate: {
      feature: "hotel.room.door_width",
      operator: "gte",
      value: 80,
      unit: "cm",
    },
  };
}
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "accesshold-contract-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("manual Access Contract vertical slice", () => {
  it("captures hard constraints as unverified draft versions without starting monitoring", async () => {
    const repository = new InMemoryContractRepository();
    const app = service(repository);
    await app.importManual(draft(), actor);

    const captured = await app.captureConstraint({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      constraint: constraintDraft(),
    });
    const constraint = captured.contract.constraints[1]!;
    expect(captured.contract.version).toBe(2);
    expect(captured.contract.status).toBe("draft");
    expect(captured.monitoring_authorized).toBe(false);
    expect(constraint).toMatchObject({
      constraint_id: "01000000000000000000000007",
      traveler_text: "I need a doorway at least 80 cm wide.",
      priority: "hard",
      applies_to: [example.assets[0]!.asset_id],
      predicate: constraintDraft().predicate,
      status: "unverified",
      evidence_ids: [],
    });
    expect(
      (await app.versionHistory(tripId, actor)).map((item) => item.version),
    ).toEqual([1, 2]);

    const activated = await app.activate({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 2,
      approvedContractVersion: 2,
    });
    expect(activated.contract.status).toBe("degraded");
    expect(activated.monitoring_authorized).toBe(true);
    expect(activated.contract.constraints[1]!.status).toBe("unverified");
  });

  it("rejects unauthorized, stale, duplicate, invalid, and post-activation constraint capture", async () => {
    const repository = new InMemoryContractRepository();
    const app = service(repository);
    await app.importManual(draft(), actor);

    await expect(
      app.captureConstraint({
        tripId,
        actorTravelerId: "01000000000000000000000099",
        expectedVersion: 1,
        constraint: constraintDraft(),
      }),
    ).rejects.toThrow("trip_access_denied");
    await expect(
      app.captureConstraint({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 2,
        constraint: constraintDraft(),
      }),
    ).rejects.toThrow("optimistic_version_conflict");
    await expect(
      app.captureConstraint({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 1,
        constraint: {
          ...constraintDraft(),
          applies_to: ["01000000000000000000000099"],
        },
      }),
    ).rejects.toThrow("applicable_asset_not_found");
    expect(
      (await app.versionHistory(tripId, actor)).map((item) => item.version),
    ).toEqual([1]);

    const duplicateApp = service(
      new InMemoryContractRepository(),
      () => example.constraints[0]!.constraint_id,
    );
    await duplicateApp.importManual(draft(), actor);
    await expect(
      duplicateApp.captureConstraint({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 1,
        constraint: constraintDraft(),
      }),
    ).rejects.toThrow("constraint_id_already_exists");
    expect(
      (await duplicateApp.versionHistory(tripId, actor)).map(
        (item) => item.version,
      ),
    ).toEqual([1]);

    await app.activate({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      approvedContractVersion: 1,
    });
    await expect(
      app.captureConstraint({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 2,
        constraint: constraintDraft(),
      }),
    ).rejects.toThrow("only_draft_contracts_can_capture_constraints");
    expect(
      (await app.getTrip(tripId, actor)).contract.constraints,
    ).toHaveLength(1);
  });

  it("generates a canonical ULID for a captured constraint", async () => {
    const app = new ManualContractService(
      schema,
      registry,
      new InMemoryContractRepository(),
      clock,
    );
    await app.importManual(draft(), actor);
    const captured = await app.captureConstraint({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      constraint: constraintDraft(),
    });
    expect(captured.contract.constraints[1]!.constraint_id).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{26}$/,
    );
  });

  it("imports, corrects, explicitly activates, and preserves version history", async () => {
    const app = service();
    const imported = await app.importManual(draft(), actor);
    expect(imported.contract.status).toBe("draft");
    expect(imported.monitoring_authorized).toBe(false);

    const correction = draft();
    correction.trip.title = "Corrected fixture hotel stay";
    const corrected = await app.correctDraft({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      document: correction,
    });
    expect(corrected.contract.version).toBe(2);
    expect(corrected.contract.trip.title).toBe("Corrected fixture hotel stay");
    await expect(
      app.correctDraft({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 1,
        document: correction,
      }),
    ).rejects.toThrow("optimistic_version_conflict");
    await expect(
      app.activate({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 2,
        approvedContractVersion: 1,
      }),
    ).rejects.toThrow("approved_contract_version_is_stale");

    const activated = await app.activate({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 2,
      approvedContractVersion: 2,
    });
    expect(activated.contract.status).toBe("active");
    expect(activated.contract.version).toBe(3);
    expect(activated.monitoring_authorized).toBe(true);
    expect(
      (await app.versionHistory(tripId, actor)).map((item) => item.version),
    ).toEqual([1, 2, 3]);
  });

  it("denies another traveler and rejects unregistered predicates", async () => {
    const app = service();
    await app.importManual(draft(), actor);
    await expect(
      app.getTrip(tripId, "01000000000000000000000099"),
    ).rejects.toThrow("trip_access_denied");

    const invalid = draft();
    invalid.constraints[0]!.predicate.feature =
      "hotel.room.unregistered_feature";
    await expect(service().importManual(invalid, actor)).rejects.toThrow(
      "unregistered_predicate",
    );
  });

  it("does not activate a known violation or an unapproved version", async () => {
    const app = service();
    const violated = draft();
    violated.evidence[0]!.features[0]!.value = false;
    await app.importManual(violated, actor);
    await expect(
      app.activate({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 1,
        approvedContractVersion: 1,
      }),
    ).rejects.toThrow("violated_contract_cannot_be_activated");
    expect((await app.getTrip(tripId, actor)).contract.status).toBe("draft");
    expect((await app.getTrip(tripId, actor)).monitoring_authorized).toBe(
      false,
    );
  });

  it("reloads fixture versions through a new file-repository instance", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "contracts.json");
    const app = service(new JsonFileFixtureContractRepository(path));
    await app.importManual(draft(), actor);
    await app.captureConstraint({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      constraint: constraintDraft(),
    });
    await app.activate({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 2,
      approvedContractVersion: 2,
    });

    const reopened = service(new JsonFileFixtureContractRepository(path));
    const reloaded = await reopened.getTrip(tripId, actor);
    expect(reloaded.contract.version).toBe(3);
    expect(reloaded.contract.constraints[1]!.traveler_text).toBe(
      constraintDraft().traveler_text,
    );
    expect(
      (await reopened.versionHistory(tripId, actor)).map((item) => item.status),
    ).toEqual(["draft", "draft", "degraded"]);
  });

  it("rejects live documents at the local persistence boundary", async () => {
    const live = { ...draft(), provenance: "live" as const };
    await expect(service().importManual(live, actor)).rejects.toThrow(
      "local_service_requires_fixture_provenance",
    );

    const app = service();
    await app.importManual(draft(), actor);
    await expect(
      app.correctDraft({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 1,
        document: live,
      }),
    ).rejects.toThrow("local_service_requires_fixture_provenance");
    expect((await app.getTrip(tripId, actor)).contract.provenance).toBe(
      "fixture",
    );
  });
});
