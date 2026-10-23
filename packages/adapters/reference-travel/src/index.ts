import type {
  AccessAsset,
  AccessEvidence,
} from "../../../contracts/src/index.js";

export interface ReferenceTravelChange {
  external_id: string;
  trip_id: string;
  asset_id: string;
  sequence: number;
  asset: AccessAsset;
  evidence: AccessEvidence;
}

export interface ReferenceTravelChangePage {
  changes: ReferenceTravelChange[];
  next_cursor: string | null;
}

export interface ReferenceTravelCapabilities {
  changeEvents: true;
  readStatus: false;
  readInventory: false;
  sandboxRebook: false;
  live: false;
  testProvider: true;
}

/** Deterministic fixture pages only. This class contains no polling or network code. */
export class FixtureReferenceTravelAdapter {
  private readonly changes: ReferenceTravelChange[];

  constructor(changes: ReferenceTravelChange[]) {
    this.changes = changes.map((change) => structuredClone(change));
  }

  capabilities(): ReferenceTravelCapabilities {
    return {
      changeEvents: true,
      readStatus: false,
      readInventory: false,
      sandboxRebook: false,
      live: false,
      testProvider: true,
    };
  }

  async fetchChanges(input: {
    tripId: string;
    cursor: string | null;
    limit?: number;
  }): Promise<ReferenceTravelChangePage> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("invalid_fixture_page_limit");
    }
    const changes = this.changes
      .filter((change) => change.trip_id === input.tripId)
      .sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.external_id.localeCompare(right.external_id),
      );
    const start =
      input.cursor === null
        ? 0
        : changes.findIndex((change) => change.external_id === input.cursor) +
          1;
    if (input.cursor !== null && start === 0) {
      throw new Error("invalid_fixture_cursor");
    }
    const page = changes.slice(start, start + limit);
    return {
      changes: page.map((change) => structuredClone(change)),
      next_cursor:
        start + limit < changes.length
          ? (page.at(-1)?.external_id ?? null)
          : null,
    };
  }
}
