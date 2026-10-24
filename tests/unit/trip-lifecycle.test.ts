import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import type { FeatureRegistry } from "../../packages/policy-engine/src/index.js";
import {
  FixtureTripArtifactDeletionAdapter,
  REQUIRED_TRIP_ARTIFACT_SCOPES,
  S3TripArtifactDeletionAdapter,
  TripDeletionService,
  type TripArtifactDeletionAdapter,
} from "../../services/importer/src/trip-deletion-service.js";
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
const now = () => new Date("2026-10-23T12:00:00.000Z");
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

function contractService(
  repository: ContractRepository = new InMemoryContractRepository(),
) {
  return {
    repository,
    contracts: new ManualContractService(schema, registry, repository, now),
  };
}

function deletionService(
  contracts: ManualContractService,
  repository: ContractRepository,
  adapter: TripArtifactDeletionAdapter = new FixtureTripArtifactDeletionAdapter(),
) {
  return new TripDeletionService(
    contracts,
    repository,
    [adapter],
    now,
    () => "6f7f8d4b-6eac-4f57-b9f9-63a4d6eb8c87",
  );
}

describe("trip export, monitoring revocation, and deletion lifecycle", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) =>
          import("node:fs/promises").then(({ rm }) =>
            rm(directory, { recursive: true, force: true }),
          ),
        ),
    );
  });

  it("exports every contract version to the owner without including raw media", async () => {
    const { contracts } = contractService();
    await contracts.importManual(draft(), actor);
    await contracts.correctDraft({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      document: {
        ...draft(),
        trip: { ...draft().trip, title: "Corrected trip title" },
      },
    });

    const exported = await contracts.exportTrip(tripId, actor);
    expect(exported).toMatchObject({
      export_version: 1,
      trip_id: tripId,
      provenance: "fixture",
    });
    expect(exported.contract_versions.map((item) => item.version)).toEqual([
      1, 2,
    ]);
    expect(exported.contract_versions[1]!.trip.title).toBe(
      "Corrected trip title",
    );
    expect(exported).not.toHaveProperty("raw_confirmation");
    await expect(
      contracts.exportTrip(tripId, "01000000000000000000000099"),
    ).rejects.toThrow("trip_access_denied");
  });

  it("revokes monitoring with a versioned terminal contract transition", async () => {
    const { contracts } = contractService();
    await contracts.importManual(draft(), actor);
    await contracts.activate({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      approvedContractVersion: 1,
    });
    const revoked = await contracts.revokeMonitoring({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 2,
    });
    expect(revoked.contract.status).toBe("closed");
    expect(revoked.contract.version).toBe(3);
    expect(revoked.monitoring_authorized).toBe(false);
    const duplicate = await contracts.revokeMonitoring({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 3,
    });
    expect(duplicate.contract.version).toBe(3);
    await expect(
      contracts.revokeMonitoring({
        tripId,
        actorTravelerId: actor,
        expectedVersion: 2,
      }),
    ).rejects.toThrow("optimistic_version_conflict");
  });

  it("requires an explicit deletion confirmation, stops monitoring, then erases contract history", async () => {
    const { contracts, repository } = contractService();
    await contracts.importManual(draft(), actor);
    await contracts.activate({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      approvedContractVersion: 1,
    });
    const adapter = new FixtureTripArtifactDeletionAdapter();
    const deletion = deletionService(contracts, repository, adapter);
    await expect(
      deletion.requestDeletion({
        tripId,
        actorTravelerId: actor,
        expectedContractVersion: 2,
        confirmationPhrase: "DELETE",
      }),
    ).rejects.toThrow("trip_deletion_confirmation_required");
    expect((await contracts.getTrip(tripId, actor)).monitoring_authorized).toBe(
      true,
    );

    const queued = await deletion.requestDeletion({
      tripId,
      actorTravelerId: actor,
      expectedContractVersion: 2,
      confirmationPhrase: "DELETE MY TRIP",
    });
    expect(queued.task.state).toBe("queued");
    expect((await contracts.getTrip(tripId, actor)).contract.status).toBe(
      "closed",
    );
    const retryRequest = await deletion.requestDeletion({
      tripId,
      actorTravelerId: actor,
      expectedContractVersion: 2,
      confirmationPhrase: "DELETE MY TRIP",
    });
    expect(retryRequest.duplicate).toBe(true);

    const result = await deletion.runTask(queued.task.task_id);
    expect(result.task.state).toBe("completed");
    expect(result.task.deleted_scopes).toContain("evidence_objects");
    expect(await repository.versions(tripId)).toEqual([]);
    await expect(contracts.getTrip(tripId, actor)).rejects.toThrow(
      "trip_not_found",
    );
    expect((await deletion.runTask(queued.task.task_id)).duplicate).toBe(true);
  });

  it("retries failed artifact deletion without deleting the primary contract early", async () => {
    let attempts = 0;
    const adapter: TripArtifactDeletionAdapter = {
      async deleteTripArtifacts() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary_storage_failure");
        return {
          adapter: "test-adapter",
          deleted_scopes: [...REQUIRED_TRIP_ARTIFACT_SCOPES],
          live: false,
        };
      },
    };
    const { contracts, repository } = contractService();
    await contracts.importManual(draft(), actor);
    const deletion = deletionService(contracts, repository, adapter);
    const queued = await deletion.requestDeletion({
      tripId,
      actorTravelerId: actor,
      expectedContractVersion: 1,
      confirmationPhrase: "DELETE MY TRIP",
    });
    await expect(deletion.runTask(queued.task.task_id)).rejects.toThrow(
      "trip_deletion_cleanup_failed",
    );
    expect((await contracts.getTrip(tripId, actor)).contract.version).toBe(1);
    expect(deletion.getTask(queued.task.task_id).state).toBe(
      "retryable_failure",
    );
    const retried = await deletion.runTask(queued.task.task_id);
    expect(retried.task.state).toBe("completed");
    expect(attempts).toBe(2);
  });

  it("schedules end-of-trip retention cleanup and honors an explicit extension", async () => {
    const { contracts, repository } = contractService();
    await contracts.importManual(draft(), actor);
    const deletion = deletionService(contracts, repository);
    await deletion.extendRetention({
      tripId,
      actorTravelerId: actor,
      expectedContractVersion: 1,
      retainUntil: "2027-01-01T00:00:00.000Z",
    });
    expect(
      await deletion.scheduleExpiredContracts({
        now: new Date("2026-12-20T00:00:00.000Z"),
      }),
    ).toEqual([]);
    const scheduled = await deletion.scheduleExpiredContracts({
      now: new Date("2027-01-02T00:00:00.000Z"),
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.source).toBe("retention_policy");
    expect((await deletion.runPending())[0]!.task.state).toBe("completed");
  });

  it("reopens a file-backed repository after deleting every trip version", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "accesshold-delete-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "contracts.json");
    const repository = new JsonFileFixtureContractRepository(path);
    const contracts = new ManualContractService(
      schema,
      registry,
      repository,
      now,
    );
    await contracts.importManual(draft(), actor);
    await contracts.activate({
      tripId,
      actorTravelerId: actor,
      expectedVersion: 1,
      approvedContractVersion: 1,
    });
    await repository.deleteTrip(tripId, 2);
    const reopened = new JsonFileFixtureContractRepository(path);
    expect(await reopened.current(tripId)).toBeUndefined();
    expect(await reopened.listCurrent()).toEqual([]);
  });

  it("deletes every S3 object version and delete marker under each paginated trip prefix", async () => {
    const commands: Array<ListObjectVersionsCommand | DeleteObjectsCommand> =
      [];
    const fakeClient = {
      async send(command: ListObjectVersionsCommand | DeleteObjectsCommand) {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          if (command.input.KeyMarker) {
            return {
              DeleteMarkers: [
                { Key: `trips/${tripId}/two`, VersionId: "delete-marker" },
              ],
              IsTruncated: false,
            };
          }
          return {
            Versions: [{ Key: `trips/${tripId}/one`, VersionId: "version-1" }],
            IsTruncated: true,
            NextKeyMarker: `trips/${tripId}/two`,
            NextVersionIdMarker: "version-2",
          };
        }
        return { Errors: [] };
      },
    } as unknown as Pick<S3Client, "send">;
    const adapter = new S3TripArtifactDeletionAdapter(
      {
        rawMedia: "raw-bucket",
        evidence: "evidence-bucket",
        exports: "exports-bucket",
      },
      fakeClient,
    );
    const result = await adapter.deleteTripArtifacts({
      tripId,
      taskId: "task-1",
    });
    expect(result.live).toBe(true);
    expect(result.deleted_scopes).toEqual([
      "raw_media",
      "evidence_objects",
      "exports",
    ]);
    const listingCommands = commands.filter(
      (command): command is ListObjectVersionsCommand =>
        command instanceof ListObjectVersionsCommand,
    );
    expect(listingCommands).toHaveLength(6);
    expect(
      commands.filter((item) => item instanceof DeleteObjectsCommand),
    ).toHaveLength(6);
    expect(
      listingCommands.every(
        (command) => command.input.Prefix === `trips/${tripId}/`,
      ),
    ).toBe(true);
    expect(
      listingCommands.filter((command) => command.input.KeyMarker).length,
    ).toBe(3);
    const deleteCommands = commands.filter(
      (command): command is DeleteObjectsCommand =>
        command instanceof DeleteObjectsCommand,
    );
    expect(
      deleteCommands.some((command) =>
        command.input.Delete?.Objects?.some(
          (object) => object.VersionId === "delete-marker",
        ),
      ),
    ).toBe(true);
  });
});
