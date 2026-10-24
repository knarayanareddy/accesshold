import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";

/** Versioned contract repository boundary; the in-memory and file implementations are fixture-only. */
export interface ContractRepository {
  current(tripId: string): Promise<AccessContractDocument | undefined>;
  versions(tripId: string): Promise<AccessContractDocument[]>;
  listCurrent(): Promise<AccessContractDocument[]>;
  listCurrentForTraveler(travelerId: string): Promise<AccessContractDocument[]>;
  append(
    document: AccessContractDocument,
    expectedVersion: number | null,
  ): Promise<void>;
  deleteTrip(tripId: string, expectedVersion: number): Promise<number>;
}

function clone(document: AccessContractDocument): AccessContractDocument {
  return structuredClone(document);
}

function latestVersions(
  documents: AccessContractDocument[],
): Map<string, AccessContractDocument> {
  const current = new Map<string, AccessContractDocument>();
  for (const document of documents) {
    const existing = current.get(document.trip.trip_id);
    if (!existing || document.version > existing.version)
      current.set(document.trip.trip_id, document);
  }
  return current;
}

/**
 * Atomic, single-writer JSON storage for synthetic local fixtures only.
 * It is not encrypted production storage and must never contain real traveler data.
 */
export class JsonFileFixtureContractRepository implements ContractRepository {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  private async readAll(): Promise<AccessContractDocument[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed))
      throw new Error("invalid_fixture_repository_format");
    for (const item of parsed) {
      if (
        typeof item !== "object" ||
        item === null ||
        !("provenance" in item) ||
        item.provenance !== "fixture" ||
        !("trip" in item) ||
        typeof item.trip !== "object" ||
        item.trip === null ||
        !("trip_id" in item.trip) ||
        typeof item.trip.trip_id !== "string"
      ) {
        throw new Error("invalid_or_live_document_in_fixture_repository");
      }
    }
    return parsed as AccessContractDocument[];
  }

  private async writeAll(documents: AccessContractDocument[]): Promise<void> {
    if (documents.some((document) => document.provenance !== "fixture")) {
      throw new Error("live_document_not_supported_by_fixture_repository");
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(documents, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async current(tripId: string): Promise<AccessContractDocument | undefined> {
    const document = latestVersions(await this.readAll()).get(tripId);
    return document ? clone(document) : undefined;
  }

  async versions(tripId: string): Promise<AccessContractDocument[]> {
    return (await this.readAll())
      .filter((document) => document.trip.trip_id === tripId)
      .sort((left, right) => left.version - right.version)
      .map(clone);
  }

  async listCurrent(): Promise<AccessContractDocument[]> {
    return [...latestVersions(await this.readAll()).values()].map(clone);
  }

  async listCurrentForTraveler(
    travelerId: string,
  ): Promise<AccessContractDocument[]> {
    return [...latestVersions(await this.readAll()).values()]
      .filter((document) => document.traveler_id === travelerId)
      .map(clone);
  }

  async append(
    document: AccessContractDocument,
    expectedVersion: number | null,
  ): Promise<void> {
    const documents = await this.readAll();
    const current = latestVersions(documents).get(document.trip.trip_id);
    if (expectedVersion === null && current)
      throw new Error("trip_already_exists");
    if (expectedVersion !== null && current?.version !== expectedVersion) {
      throw new Error("optimistic_version_conflict");
    }
    const expectedNewVersion =
      expectedVersion === null ? 1 : expectedVersion + 1;
    if (document.version !== expectedNewVersion)
      throw new Error("invalid_next_contract_version");
    if (
      documents.some(
        (item) =>
          item.contract_id === document.contract_id &&
          item.version === document.version,
      )
    ) {
      throw new Error("contract_version_already_exists");
    }
    documents.push(clone(document));
    await this.writeAll(documents);
  }

  async deleteTrip(tripId: string, expectedVersion: number): Promise<number> {
    const documents = await this.readAll();
    const current = latestVersions(documents).get(tripId);
    if (!current) throw new Error("trip_not_found");
    if (current.version !== expectedVersion)
      throw new Error("optimistic_version_conflict");
    const retained = documents.filter(
      (document) => document.trip.trip_id !== tripId,
    );
    const deleted = documents.length - retained.length;
    await this.writeAll(retained);
    return deleted;
  }
}

export { InMemoryContractRepository } from "./in-memory-contract-repository.js";
