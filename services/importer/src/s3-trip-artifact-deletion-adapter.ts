import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
  type DeleteObjectsCommandOutput,
  type ListObjectVersionsCommandOutput,
} from "@aws-sdk/client-s3";
import type {
  TripArtifactDeletionAdapter,
  TripArtifactDeletionResult,
} from "./trip-deletion-core.js";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface S3TripArtifactBuckets {
  rawMedia: string;
  evidence: string;
  exports: string;
}

/** Deletes objects under a traveler-authorized trip prefix in configured buckets. */
export class S3TripArtifactDeletionAdapter
  implements TripArtifactDeletionAdapter
{
  private readonly client: Pick<S3Client, "send">;

  constructor(
    private readonly buckets: S3TripArtifactBuckets,
    client: Pick<S3Client, "send"> = new S3Client({}),
  ) {
    if (Object.values(buckets).some((bucket) => !bucket.trim())) {
      throw new Error("trip_deletion_bucket_configuration_required");
    }
    this.client = client;
  }

  private async deletePrefix(bucket: string, prefix: string): Promise<number> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let deletedCount = 0;
    do {
      const listed = (await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
        }),
      )) as ListObjectVersionsCommandOutput;
      const entries = [
        ...(listed.Versions ?? []),
        ...(listed.DeleteMarkers ?? []),
      ];
      const objects = entries.map((entry) => {
        if (
          typeof entry.Key !== "string" ||
          typeof entry.VersionId !== "string"
        )
          throw new Error("s3_trip_artifact_version_listing_invalid");
        return { Key: entry.Key, VersionId: entry.VersionId };
      });
      if (objects.length > 0) {
        const deleted = (await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        )) as DeleteObjectsCommandOutput;
        if (deleted.Errors?.length)
          throw new Error("s3_trip_artifact_delete_failed");
        deletedCount += objects.length;
      }
      if (!listed.IsTruncated) {
        keyMarker = undefined;
        versionIdMarker = undefined;
      } else {
        if (
          typeof listed.NextKeyMarker !== "string" ||
          typeof listed.NextVersionIdMarker !== "string"
        ) {
          throw new Error("s3_trip_artifact_version_pagination_invalid");
        }
        keyMarker = listed.NextKeyMarker;
        versionIdMarker = listed.NextVersionIdMarker;
      }
    } while (keyMarker);
    return deletedCount;
  }

  async deleteTripArtifacts(input: {
    tripId: string;
    taskId: string;
  }): Promise<TripArtifactDeletionResult> {
    if (!ULID_PATTERN.test(input.tripId))
      throw new Error("trip_deletion_trip_id_invalid");
    const prefix = `trips/${input.tripId}/`;
    await Promise.all([
      this.deletePrefix(this.buckets.rawMedia, prefix),
      this.deletePrefix(this.buckets.evidence, prefix),
      this.deletePrefix(this.buckets.exports, prefix),
    ]);
    return {
      adapter: "aws-s3-trip-artifact-deletion",
      deleted_scopes: ["raw_media", "evidence_objects", "exports"],
      live: true,
    };
  }
}
