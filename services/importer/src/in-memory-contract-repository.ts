import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";
import type { ContractRepository } from "./contract-repository.js";

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

export class InMemoryContractRepository implements ContractRepository {
  private readonly documents: AccessContractDocument[] = [];

  async current(tripId: string): Promise<AccessContractDocument | undefined> {
    const document = latestVersions(this.documents).get(tripId);
    return document ? clone(document) : undefined;
  }

  async versions(tripId: string): Promise<AccessContractDocument[]> {
    return this.documents
      .filter((document) => document.trip.trip_id === tripId)
      .sort((left, right) => left.version - right.version)
      .map(clone);
  }

  async listCurrent(): Promise<AccessContractDocument[]> {
    return [...latestVersions(this.documents).values()].map(clone);
  }

  async listCurrentForTraveler(
    travelerId: string,
  ): Promise<AccessContractDocument[]> {
    return [...latestVersions(this.documents).values()]
      .filter((document) => document.traveler_id === travelerId)
      .map(clone);
  }

  async append(
    document: AccessContractDocument,
    expectedVersion: number | null,
  ): Promise<void> {
    if (document.provenance !== "fixture")
      throw new Error("live_document_not_supported_by_fixture_repository");
    const current = latestVersions(this.documents).get(document.trip.trip_id);
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
      this.documents.some(
        (item) =>
          item.contract_id === document.contract_id &&
          item.version === document.version,
      )
    ) {
      throw new Error("contract_version_already_exists");
    }
    this.documents.push(clone(document));
  }

  async deleteTrip(tripId: string, expectedVersion: number): Promise<number> {
    const current = latestVersions(this.documents).get(tripId);
    if (!current) throw new Error("trip_not_found");
    if (current.version !== expectedVersion)
      throw new Error("optimistic_version_conflict");
    let deleted = 0;
    for (let index = this.documents.length - 1; index >= 0; index -= 1) {
      if (this.documents[index]!.trip.trip_id === tripId) {
        this.documents.splice(index, 1);
        deleted += 1;
      }
    }
    return deleted;
  }
}
