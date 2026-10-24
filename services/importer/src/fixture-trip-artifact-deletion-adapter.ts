import {
  REQUIRED_TRIP_ARTIFACT_SCOPES,
  type TripArtifactDeletionAdapter,
  type TripArtifactDeletionResult,
} from "./trip-deletion-core.js";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Local deletion adapter: records cleanup intent and removes no external data. */
export class FixtureTripArtifactDeletionAdapter
  implements TripArtifactDeletionAdapter
{
  private readonly completed = new Map<string, TripArtifactDeletionResult>();

  async deleteTripArtifacts(input: {
    tripId: string;
    taskId: string;
  }): Promise<TripArtifactDeletionResult> {
    const existing = this.completed.get(input.taskId);
    if (existing) return clone(existing);
    if (!ULID_PATTERN.test(input.tripId))
      throw new Error("trip_deletion_trip_id_invalid");
    const result: TripArtifactDeletionResult = {
      adapter: "fixture-deletion-adapter",
      deleted_scopes: [...REQUIRED_TRIP_ARTIFACT_SCOPES],
      live: false,
    };
    this.completed.set(input.taskId, result);
    return clone(result);
  }
}
