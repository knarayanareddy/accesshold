import { sha256Hex } from "../../../packages/domain/src/hash.js";
import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  validateAccessContractSemantics,
  type AccessAsset,
  type AccessConstraint,
  type AccessContractDocument,
  type AccessEvidence,
} from "../../../packages/contracts/src/index.js";
import {
  evaluateAccessContract,
  type ContractEvaluation,
  type FeatureRegistry,
} from "../../../packages/policy-engine/src/index.js";
import {
  FixtureReferenceTravelAdapter,
  type ReferenceTravelChange,
  type ReferenceTravelChangePage,
} from "../../../packages/adapters/reference-travel/src/index.js";
import type { ContractRepository } from "../../importer/src/contract-repository.js";

export interface AssetVersionRecord {
  trip_id: string;
  asset_id: string;
  version: number;
  contract_version: number;
  origin_event_id: string | null;
  asset: AccessAsset;
}

export interface EvidenceVersionRecord {
  trip_id: string;
  evidence_id: string;
  asset_id: string;
  version: number;
  contract_version: number;
  origin_event_id: string | null;
  evidence: AccessEvidence;
}

export interface AffectedAssetVersion {
  asset_id: string;
  asset_version: number;
  evidence_id: string;
  evidence_version: number;
}

export type RecoveryTimelineCode =
  | "violation_detected"
  | "violation_re_evaluated"
  | "equivalent_change_attached"
  | "recovery_degraded"
  | "recovery_completed";

export interface RecoveryTimelineEntry {
  version: number;
  code: RecoveryTimelineCode;
  event_external_id: string;
  contract_version: number;
  evaluation_status: ContractEvaluation["status"];
  constraint_ids: string[];
  affected_assets: AffectedAssetVersion[];
  recorded_at: string;
}

export interface RecoveryCase {
  case_id: string;
  trip_id: string;
  constraint_version: number;
  state: "detected" | "completed";
  opened_by_event_id: string;
  version: number;
  constraint_ids: string[];
  opened_at: string;
  updated_at: string;
  completed_at?: string;
  timeline: RecoveryTimelineEntry[];
}

export interface MonitoringResult {
  external_id: string;
  disposition: "processed" | "stale" | "equivalent";
  duplicate: boolean;
  contract: AccessContractDocument;
  evaluation: ContractEvaluation;
  affected_asset: AffectedAssetVersion;
  recovery_case?: RecoveryCase;
  provider_notice: "TEST PROVIDER — fixture change only; no live travel or accessibility guarantee";
}

interface TripHistory {
  assets: AssetVersionRecord[];
  evidence: EvidenceVersionRecord[];
}

interface StoredEvent {
  fingerprint: string;
  result: MonitoringResult;
}

const providerNotice =
  "TEST PROVIDER — fixture change only; no live travel or accessibility guarantee" as const;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

function fingerprint(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Single-writer, in-memory fixture monitor. No scheduler, provider worker, or live adapter. */
export class ReferenceTravelMonitor {
  private readonly validateSchema: ValidateFunction;
  private readonly events = new Map<string, StoredEvent>();
  private readonly histories = new Map<string, TripHistory>();
  private readonly latestSequences = new Map<string, number>();
  private recoveryCases: RecoveryCase[] = [];

  constructor(
    schema: object,
    private readonly registry: FeatureRegistry,
    private readonly repository: ContractRepository,
    private readonly adapter: FixtureReferenceTravelAdapter,
    private readonly clock: () => Date = () => new Date(),
  ) {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
    });
    addFormats(ajv);
    this.validateSchema = ajv.compile(schema);
  }

  private validateDocument(document: AccessContractDocument): void {
    if (!this.validateSchema(document)) {
      const issues = (this.validateSchema.errors ?? []).map(
        (error) =>
          `schema:${error.instancePath || "/"}:${error.message ?? "invalid"}`,
      );
      throw new Error(`contract_validation_failed:${issues.sort().join(",")}`);
    }
    const issues = validateAccessContractSemantics(document);
    const registered = new Set(
      this.registry.features.map((feature) => feature.key),
    );
    for (const constraint of document.constraints) {
      if (!registered.has(constraint.predicate.feature)) {
        issues.push(`unregistered_predicate:${constraint.constraint_id}`);
      }
    }
    if (document.provenance !== "fixture") {
      issues.push("local_monitor_requires_fixture_provenance");
    }
    if (issues.length > 0) {
      throw new Error(
        `contract_validation_failed:${uniqueSorted(issues).join(",")}`,
      );
    }
  }

  private async current(
    tripId: string,
    actorTravelerId: string,
  ): Promise<AccessContractDocument> {
    const document = await this.repository.current(tripId);
    if (!document) throw new Error("trip_not_found");
    if (document.traveler_id !== actorTravelerId) {
      throw new Error("trip_access_denied");
    }
    this.validateDocument(document);
    return document;
  }

  private evaluate(
    document: AccessContractDocument,
    now: Date = this.clock(),
  ): ContractEvaluation {
    return evaluateAccessContract({
      document,
      registry: this.registry,
      now,
      allowFixture: true,
    });
  }

  private history(document: AccessContractDocument): TripHistory {
    const existing = this.histories.get(document.trip.trip_id);
    if (existing) return structuredClone(existing);
    return {
      assets: document.assets.map((asset) => ({
        trip_id: document.trip.trip_id,
        asset_id: asset.asset_id,
        version: 0,
        contract_version: document.version,
        origin_event_id: null,
        asset: structuredClone(asset),
      })),
      evidence: document.evidence.map((evidence) => ({
        trip_id: document.trip.trip_id,
        evidence_id: evidence.evidence_id,
        asset_id: evidence.asset_id,
        version: 0,
        contract_version: document.version,
        origin_event_id: null,
        evidence: structuredClone(evidence),
      })),
    };
  }

  private validateChange(
    current: AccessContractDocument,
    change: ReferenceTravelChange,
  ): { asset: AccessAsset; evidence: AccessEvidence } {
    if (
      !change.external_id.trim() ||
      !change.asset_id.trim() ||
      change.trip_id !== current.trip.trip_id
    ) {
      throw new Error("invalid_reference_travel_change_identity");
    }
    if (!Number.isSafeInteger(change.sequence) || change.sequence < 1) {
      throw new Error("invalid_reference_travel_sequence");
    }
    const asset = current.assets.find(
      (item) => item.asset_id === change.asset_id,
    );
    const evidence = current.evidence.find(
      (item) =>
        item.evidence_id === change.evidence.evidence_id &&
        item.asset_id === change.asset_id,
    );
    if (!asset || !evidence)
      throw new Error("unknown_asset_or_evidence_stream");
    if (
      change.asset.asset_id !== change.asset_id ||
      change.asset.kind !== asset.kind ||
      change.asset.provider !== asset.provider ||
      change.evidence.asset_id !== change.asset_id
    ) {
      throw new Error("reference_travel_stream_identity_cannot_change");
    }
    if (
      change.evidence.provenance !== "fixture" ||
      change.evidence.source_type !== "fixture" ||
      change.evidence.verification_level === "provider_confirmed"
    ) {
      throw new Error("reference_travel_requires_non_live_fixture_evidence");
    }
    return { asset, evidence };
  }

  private affected(
    history: TripHistory,
    change: ReferenceTravelChange,
  ): AffectedAssetVersion {
    const asset = history.assets.findLast(
      (item) =>
        item.trip_id === change.trip_id && item.asset_id === change.asset_id,
    );
    const evidence = history.evidence.findLast(
      (item) =>
        item.trip_id === change.trip_id &&
        item.evidence_id === change.evidence.evidence_id,
    );
    if (!asset || !evidence) throw new Error("version_history_not_initialized");
    return {
      asset_id: asset.asset_id,
      asset_version: asset.version,
      evidence_id: evidence.evidence_id,
      evidence_version: evidence.version,
    };
  }

  private updateCases(input: {
    current: AccessContractDocument;
    contractVersion: number;
    evaluation: ContractEvaluation;
    change: ReferenceTravelChange;
    affected: AffectedAssetVersion;
    recordedAt: string;
    equivalent: boolean;
    cases: RecoveryCase[];
  }): RecoveryCase | undefined {
    const openIndex = input.cases.findIndex(
      (item) =>
        item.trip_id === input.current.trip.trip_id &&
        item.state === "detected",
    );
    const open = openIndex >= 0 ? input.cases[openIndex] : undefined;
    const violated = input.evaluation.constraints
      .filter(
        (constraint) =>
          constraint.priority === "hard" && constraint.status === "violated",
      )
      .map((constraint) => constraint.constraint_id);
    const unknown = input.evaluation.constraints
      .filter(
        (constraint) =>
          constraint.priority === "hard" && constraint.status === "unknown",
      )
      .map((constraint) => constraint.constraint_id);

    if (!open && input.evaluation.status !== "violated") return undefined;
    const code: RecoveryTimelineCode =
      input.evaluation.status === "active" && open
        ? "recovery_completed"
        : input.equivalent && open
          ? "equivalent_change_attached"
          : open
            ? input.evaluation.status === "violated"
              ? "violation_re_evaluated"
              : "recovery_degraded"
            : "violation_detected";
    const constraintIds = uniqueSorted(
      input.evaluation.status === "violated"
        ? [...(open?.constraint_ids ?? []), ...violated]
        : input.evaluation.status === "degraded"
          ? [...(open?.constraint_ids ?? []), ...unknown]
          : (open?.constraint_ids ?? []),
    );
    const entry: RecoveryTimelineEntry = {
      version: (open?.timeline.length ?? 0) + 1,
      code,
      event_external_id: input.change.external_id,
      contract_version: input.contractVersion,
      evaluation_status: input.evaluation.status,
      constraint_ids: constraintIds,
      affected_assets: [structuredClone(input.affected)],
      recorded_at: input.recordedAt,
    };
    if (open) {
      open.timeline.push(entry);
      open.version = open.timeline.length;
      open.updated_at = input.recordedAt;
      open.constraint_ids = constraintIds;
      if (input.evaluation.status === "active") {
        open.state = "completed";
        open.completed_at = input.recordedAt;
      }
      return open;
    }
    const caseId = `fixture-case-${fingerprint(`${input.change.trip_id}:${input.change.external_id}:${input.current.version}`).slice(0, 20)}`;
    const created: RecoveryCase = {
      case_id: caseId,
      trip_id: input.change.trip_id,
      constraint_version: input.current.version,
      state: "detected",
      opened_by_event_id: input.change.external_id,
      version: 1,
      constraint_ids: constraintIds,
      opened_at: input.recordedAt,
      updated_at: input.recordedAt,
      timeline: [entry],
    };
    input.cases.push(created);
    return created;
  }

  private applyConstraintEvaluation(
    document: AccessContractDocument,
    evaluation: ContractEvaluation,
  ): AccessConstraint[] {
    return document.constraints.map((constraint, index) => {
      if (constraint.status === "not_applicable") return constraint;
      const result = evaluation.constraints[index];
      if (!result) throw new Error("constraint_evaluation_missing");
      if (result.status === "violated") {
        return { ...constraint, status: "violated" };
      }
      if (result.status === "unknown") {
        return { ...constraint, status: "unverified" };
      }
      const evidence = document.evidence.filter((item) =>
        constraint.evidence_ids.includes(item.evidence_id),
      );
      const status = evidence.some(
        (item) => item.verification_level === "provider_confirmed",
      )
        ? "provider_confirmed"
        : evidence.some((item) => item.verification_level === "documented")
          ? "documented"
          : "unverified";
      return { ...constraint, status };
    });
  }

  private result(input: {
    change: ReferenceTravelChange;
    disposition: MonitoringResult["disposition"];
    contract: AccessContractDocument;
    evaluation: ContractEvaluation;
    affected: AffectedAssetVersion;
    recoveryCase?: RecoveryCase;
  }): MonitoringResult {
    return {
      external_id: input.change.external_id,
      disposition: input.disposition,
      duplicate: false,
      contract: structuredClone(input.contract),
      evaluation: structuredClone(input.evaluation),
      affected_asset: structuredClone(input.affected),
      ...(input.recoveryCase
        ? { recovery_case: structuredClone(input.recoveryCase) }
        : {}),
      provider_notice: providerNotice,
    };
  }

  async ingest(
    change: ReferenceTravelChange,
    actorTravelerId: string,
  ): Promise<MonitoringResult> {
    const current = await this.current(change.trip_id, actorTravelerId);
    const changeFingerprint = fingerprint(change);
    const existing = this.events.get(change.external_id);
    if (existing) {
      if (existing.fingerprint !== changeFingerprint) {
        throw new Error("provider_event_replay_conflict");
      }
      return { ...structuredClone(existing.result), duplicate: true };
    }
    if (!["active", "degraded", "violated"].includes(current.status)) {
      throw new Error("monitoring_not_authorized_for_contract_status");
    }
    this.validateChange(current, change);
    const evaluationAt = this.clock();
    const recordedAt = evaluationAt.toISOString();
    if (Date.parse(recordedAt) < Date.parse(current.updated_at)) {
      throw new Error("event_received_before_current_contract_version");
    }
    const history = this.history(current);
    const affected = this.affected(history, change);
    const sequenceKey = `${change.trip_id}:${change.asset_id}`;
    const latestSequence = this.latestSequences.get(sequenceKey);
    if (latestSequence === change.sequence) {
      throw new Error("provider_sequence_conflict");
    }
    const cases = structuredClone(this.recoveryCases);
    if (latestSequence !== undefined && change.sequence < latestSequence) {
      const evaluation = this.evaluate(current, evaluationAt);
      const openCase = cases.find(
        (item) => item.trip_id === change.trip_id && item.state === "detected",
      );
      const result = this.result({
        change,
        disposition: "stale",
        contract: current,
        evaluation,
        affected,
        ...(openCase ? { recoveryCase: openCase } : {}),
      });
      this.histories.set(change.trip_id, history);
      this.recoveryCases = cases;
      this.events.set(change.external_id, {
        fingerprint: changeFingerprint,
        result,
      });
      return structuredClone(result);
    }

    const currentAsset = current.assets.find(
      (item) => item.asset_id === change.asset_id,
    );
    const currentEvidence = current.evidence.find(
      (item) => item.evidence_id === change.evidence.evidence_id,
    );
    if (!currentAsset || !currentEvidence)
      throw new Error("version_history_not_initialized");
    const equivalent =
      canonicalize(currentAsset) === canonicalize(change.asset) &&
      canonicalize(currentEvidence) === canonicalize(change.evidence);
    if (equivalent) {
      const evaluation = this.evaluate(current, evaluationAt);
      const recoveryCase = this.updateCases({
        current,
        contractVersion: current.version,
        evaluation,
        change,
        affected,
        recordedAt,
        equivalent: true,
        cases,
      });
      const result = this.result({
        change,
        disposition: "equivalent",
        contract: current,
        evaluation,
        affected,
        ...(recoveryCase ? { recoveryCase } : {}),
      });
      this.histories.set(change.trip_id, history);
      this.latestSequences.set(sequenceKey, change.sequence);
      this.recoveryCases = cases;
      this.events.set(change.external_id, {
        fingerprint: changeFingerprint,
        result,
      });
      return structuredClone(result);
    }

    const nextAssetVersion = affected.asset_version + 1;
    const nextEvidenceVersion = affected.evidence_version + 1;
    history.assets.push({
      trip_id: change.trip_id,
      asset_id: change.asset_id,
      version: nextAssetVersion,
      contract_version: current.version + 1,
      origin_event_id: change.external_id,
      asset: structuredClone(change.asset),
    });
    history.evidence.push({
      trip_id: change.trip_id,
      evidence_id: change.evidence.evidence_id,
      asset_id: change.asset_id,
      version: nextEvidenceVersion,
      contract_version: current.version + 1,
      origin_event_id: change.external_id,
      evidence: structuredClone(change.evidence),
    });
    const nextAffected: AffectedAssetVersion = {
      asset_id: change.asset_id,
      asset_version: nextAssetVersion,
      evidence_id: change.evidence.evidence_id,
      evidence_version: nextEvidenceVersion,
    };
    const next: AccessContractDocument = {
      ...structuredClone(current),
      assets: current.assets.map((asset) =>
        asset.asset_id === change.asset_id
          ? structuredClone(change.asset)
          : asset,
      ),
      evidence: current.evidence.map((evidence) =>
        evidence.evidence_id === change.evidence.evidence_id
          ? structuredClone(change.evidence)
          : evidence,
      ),
      version: current.version + 1,
      updated_at: recordedAt,
    };
    const evaluation = this.evaluate(next, evaluationAt);
    next.status = evaluation.status;
    next.constraints = this.applyConstraintEvaluation(next, evaluation);
    this.validateDocument(next);
    const recoveryCase = this.updateCases({
      current,
      contractVersion: next.version,
      evaluation,
      change,
      affected: nextAffected,
      recordedAt,
      equivalent: false,
      cases,
    });
    await this.repository.append(next, current.version);
    const result = this.result({
      change,
      disposition: "processed",
      contract: next,
      evaluation,
      affected: nextAffected,
      ...(recoveryCase ? { recoveryCase } : {}),
    });
    this.histories.set(change.trip_id, history);
    this.latestSequences.set(sequenceKey, change.sequence);
    this.recoveryCases = cases;
    this.events.set(change.external_id, {
      fingerprint: changeFingerprint,
      result,
    });
    return structuredClone(result);
  }

  async pollFixtureOnce(input: {
    tripId: string;
    actorTravelerId: string;
    cursor: string | null;
    limit?: number;
  }): Promise<ReferenceTravelChangePage & { results: MonitoringResult[] }> {
    const page = await this.adapter.fetchChanges({
      tripId: input.tripId,
      cursor: input.cursor,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const results: MonitoringResult[] = [];
    for (const change of page.changes) {
      results.push(await this.ingest(change, input.actorTravelerId));
    }
    return { ...page, results };
  }

  async assetHistory(
    tripId: string,
    assetId: string,
    actorTravelerId: string,
  ): Promise<AssetVersionRecord[]> {
    const current = await this.current(tripId, actorTravelerId);
    return this.history(current).assets.filter(
      (item) => item.asset_id === assetId,
    );
  }

  async evidenceHistory(
    tripId: string,
    evidenceId: string,
    actorTravelerId: string,
  ): Promise<EvidenceVersionRecord[]> {
    const current = await this.current(tripId, actorTravelerId);
    return this.history(current).evidence.filter(
      (item) => item.evidence_id === evidenceId,
    );
  }

  async cases(
    tripId: string,
    actorTravelerId: string,
  ): Promise<RecoveryCase[]> {
    await this.current(tripId, actorTravelerId);
    return structuredClone(
      this.recoveryCases.filter((item) => item.trip_id === tripId),
    );
  }
}
