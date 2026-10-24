import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";
import type { ContractRepository } from "./contract-repository.js";
import type { ManualContractService } from "./manual-contract-service.js";

export type TripDeletionSource = "traveler_request" | "retention_policy";
export type TripDeletionState =
  | "queued"
  | "running"
  | "retryable_failure"
  | "blocked"
  | "completed";

export const REQUIRED_TRIP_ARTIFACT_SCOPES = [
  "raw_media",
  "evidence_objects",
  "exports",
  "viewer_tokens",
  "cached_prompts",
] as const;

export type TripArtifactScope = (typeof REQUIRED_TRIP_ARTIFACT_SCOPES)[number];

export interface TripDeletionTask {
  task_id: string;
  trip_id: string;
  requested_by: string;
  requested_contract_version: number;
  expected_contract_version: number;
  source: TripDeletionSource;
  state: TripDeletionState;
  requested_at: string;
  attempts: number;
  deleted_scopes: TripArtifactScope[];
  last_error_code?: string;
}

export interface TripArtifactDeletionResult {
  adapter: string;
  deleted_scopes: TripArtifactScope[];
  live: boolean;
}

export interface TripArtifactDeletionAdapter {
  deleteTripArtifacts(input: {
    tripId: string;
    taskId: string;
  }): Promise<TripArtifactDeletionResult>;
}

export interface TripDeletionResult {
  task: TripDeletionTask;
  duplicate: boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Local deletion/retention workflow. Production deployments must replace its
 * in-memory task and retention state with durable stores and configure every
 * artifact-erasure adapter before enabling the worker.
 */
export class TripDeletionService {
  private readonly tasks = new Map<string, TripDeletionTask>();
  private readonly taskIdByTrip = new Map<string, string>();
  private readonly retentionExtensions = new Map<string, string>();

  constructor(
    private readonly contracts: Pick<
      ManualContractService,
      "getTrip" | "revokeMonitoring"
    >,
    private readonly repository: ContractRepository,
    private readonly artifactAdapters: TripArtifactDeletionAdapter[],
    private readonly clock: () => Date = () => new Date(),
    private readonly taskIdFactory: () => string = () =>
      globalThis.crypto.randomUUID(),
  ) {}

  async requestDeletion(input: {
    tripId: string;
    actorTravelerId: string;
    expectedContractVersion: number;
    confirmationPhrase: string;
  }): Promise<TripDeletionResult> {
    if (input.confirmationPhrase !== "DELETE MY TRIP")
      throw new Error("trip_deletion_confirmation_required");
    const existingTaskId = this.taskIdByTrip.get(input.tripId);
    if (existingTaskId) {
      const existing = this.task(existingTaskId);
      if (
        existing.requested_contract_version !== input.expectedContractVersion ||
        existing.requested_by !== input.actorTravelerId
      ) {
        throw new Error("trip_deletion_request_conflict");
      }
      return { task: clone(existing), duplicate: true };
    }
    if (this.artifactAdapters.length === 0)
      throw new Error("trip_deletion_adapters_not_configured");
    const current = await this.contracts.getTrip(
      input.tripId,
      input.actorTravelerId,
    );
    if (current.contract.version !== input.expectedContractVersion)
      throw new Error("optimistic_version_conflict");
    const deletionVersion = await this.stopMonitoringForDeletion(
      current.contract,
      input.actorTravelerId,
    );
    return this.enqueue({
      tripId: input.tripId,
      requestedBy: input.actorTravelerId,
      requestedContractVersion: input.expectedContractVersion,
      expectedVersion: deletionVersion,
      source: "traveler_request",
    });
  }

  async extendRetention(input: {
    tripId: string;
    actorTravelerId: string;
    expectedContractVersion: number;
    retainUntil: string;
  }): Promise<{ tripId: string; retain_until: string }> {
    if (this.taskIdByTrip.has(input.tripId))
      throw new Error("trip_deletion_already_started");
    const current = await this.contracts.getTrip(
      input.tripId,
      input.actorTravelerId,
    );
    if (current.contract.version !== input.expectedContractVersion)
      throw new Error("optimistic_version_conflict");
    const untilMs = Date.parse(input.retainUntil);
    const now = this.clock();
    if (
      !Number.isFinite(untilMs) ||
      !Number.isFinite(now.getTime()) ||
      untilMs <= now.getTime()
    ) {
      throw new Error("retention_extension_invalid");
    }
    this.retentionExtensions.set(input.tripId, new Date(untilMs).toISOString());
    return {
      tripId: input.tripId,
      retain_until: new Date(untilMs).toISOString(),
    };
  }

  async scheduleExpiredContracts(
    input: {
      now?: Date;
      retentionDays?: number;
    } = {},
  ): Promise<TripDeletionTask[]> {
    const now = input.now ?? this.clock();
    const retentionDays = input.retentionDays ?? 30;
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(retentionDays) ||
      retentionDays < 0
    ) {
      throw new Error("retention_schedule_input_invalid");
    }
    if (this.artifactAdapters.length === 0)
      throw new Error("trip_deletion_adapters_not_configured");
    const scheduled: TripDeletionTask[] = [];
    for (const current of await this.repository.listCurrent()) {
      const extendedUntil = this.retentionExtensions.get(current.trip.trip_id);
      if (extendedUntil && Date.parse(extendedUntil) > now.getTime()) continue;
      const expiresAt =
        Date.parse(current.trip.ends_at) + retentionDays * 86_400_000;
      if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) continue;
      const existingId = this.taskIdByTrip.get(current.trip.trip_id);
      if (existingId) {
        scheduled.push(clone(this.task(existingId)));
        continue;
      }
      const deletionVersion = await this.stopMonitoringForDeletion(
        current,
        current.traveler_id,
      );
      const result = await this.enqueue({
        tripId: current.trip.trip_id,
        requestedBy: current.traveler_id,
        requestedContractVersion: current.version,
        expectedVersion: deletionVersion,
        source: "retention_policy",
      });
      scheduled.push(result.task);
    }
    return scheduled;
  }

  async runTask(taskId: string): Promise<TripDeletionResult> {
    const task = this.task(taskId);
    if (task.state === "completed")
      return { task: clone(task), duplicate: true };
    if (task.state === "blocked")
      throw new Error(task.last_error_code ?? "trip_deletion_blocked");
    if (task.state === "running") throw new Error("trip_deletion_in_progress");
    task.state = "running";
    task.attempts += 1;
    delete task.last_error_code;
    try {
      const current = await this.contracts.getTrip(
        task.trip_id,
        task.requested_by,
      );
      if (current.contract.version !== task.expected_contract_version) {
        task.state = "blocked";
        task.last_error_code = "trip_deletion_contract_changed";
        throw new Error("trip_deletion_contract_changed");
      }
      const completedScopes = new Set(task.deleted_scopes);
      for (const adapter of this.artifactAdapters) {
        const result = await adapter.deleteTripArtifacts({
          tripId: task.trip_id,
          taskId: task.task_id,
        });
        for (const scope of result.deleted_scopes) {
          if (!REQUIRED_TRIP_ARTIFACT_SCOPES.includes(scope))
            throw new Error("trip_deletion_adapter_scope_invalid");
          completedScopes.add(scope);
        }
        task.deleted_scopes = [...REQUIRED_TRIP_ARTIFACT_SCOPES].filter(
          (scope) => completedScopes.has(scope),
        );
      }
      if (
        REQUIRED_TRIP_ARTIFACT_SCOPES.some(
          (scope) => !completedScopes.has(scope),
        )
      ) {
        task.last_error_code = "trip_deletion_scope_incomplete";
        throw new Error("trip_deletion_scope_incomplete");
      }
      await this.repository.deleteTrip(
        task.trip_id,
        task.expected_contract_version,
      );
      task.state = "completed";
      this.retentionExtensions.delete(task.trip_id);
      return { task: clone(task), duplicate: false };
    } catch (error) {
      if (task.state === "blocked") throw error;
      task.state = "retryable_failure";
      const safeCode =
        error instanceof Error &&
        error.message === "trip_deletion_scope_incomplete"
          ? error.message
          : "trip_deletion_cleanup_failed";
      task.last_error_code = safeCode;
      throw new Error(safeCode, { cause: error });
    }
  }

  async runPending(): Promise<TripDeletionResult[]> {
    const pending = [...this.tasks.values()].filter(
      (task) => task.state === "queued" || task.state === "retryable_failure",
    );
    const results: TripDeletionResult[] = [];
    for (const task of pending) results.push(await this.runTask(task.task_id));
    return results;
  }

  getTask(taskId: string): TripDeletionTask {
    return clone(this.task(taskId));
  }

  private async stopMonitoringForDeletion(
    document: AccessContractDocument,
    actorTravelerId: string,
  ): Promise<number> {
    if (document.status === "draft" || document.status === "closed")
      return document.version;
    const revoked = await this.contracts.revokeMonitoring({
      tripId: document.trip.trip_id,
      actorTravelerId,
      expectedVersion: document.version,
    });
    return revoked.contract.version;
  }

  private async enqueue(input: {
    tripId: string;
    requestedBy: string;
    requestedContractVersion: number;
    expectedVersion: number;
    source: TripDeletionSource;
  }): Promise<TripDeletionResult> {
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("trip_deletion_clock_invalid");
    const taskId = this.taskIdFactory();
    if (this.tasks.has(taskId))
      throw new Error("trip_deletion_task_id_conflict");
    const task: TripDeletionTask = {
      task_id: taskId,
      trip_id: input.tripId,
      requested_by: input.requestedBy,
      requested_contract_version: input.requestedContractVersion,
      expected_contract_version: input.expectedVersion,
      source: input.source,
      state: "queued",
      requested_at: now.toISOString(),
      attempts: 0,
      deleted_scopes: [],
    };
    this.tasks.set(taskId, task);
    this.taskIdByTrip.set(input.tripId, taskId);
    return { task: clone(task), duplicate: false };
  }

  private task(taskId: string): TripDeletionTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("trip_deletion_task_not_found");
    return task;
  }
}
