import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  validateAccessContractSemantics,
  type AccessContractDocument,
} from "../../../packages/contracts/src/index.js";
import {
  createAccessConstraint,
  type ConstraintCaptureDraft,
} from "../../../packages/domain/src/index.js";
import {
  evaluateAccessContract,
  type FeatureRegistry,
} from "../../../packages/policy-engine/src/index.js";
import type { ContractRepository } from "./contract-repository.js";

export interface CaptureConstraintInput {
  tripId: string;
  actorTravelerId: string;
  expectedVersion: number;
  constraint: ConstraintCaptureDraft;
}

export interface ContractView {
  contract: AccessContractDocument;
  monitoring_authorized: boolean;
  provenance: "fixture";
}

export interface TripContractExport {
  export_version: 1;
  trip_id: string;
  exported_at: string;
  provenance: "fixture";
  contract_versions: AccessContractDocument[];
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type ConstraintIdFactory = (at: Date) => string;

function createUlid(at: Date): string {
  const milliseconds = at.getTime();
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 0xffffffffffff
  ) {
    throw new Error("invalid_constraint_capture_clock");
  }

  const random = globalThis.crypto.getRandomValues(new Uint8Array(10));
  const randomHex = Array.from(random, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  let value = (BigInt(milliseconds) << 80n) | BigInt(`0x${randomHex}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = `${ULID_ALPHABET[Number(value & 31n)]!}${encoded}`;
    value >>= 5n;
  }
  return encoded;
}

function monitoringEnabled(document: AccessContractDocument): boolean {
  return document.status !== "draft" && document.status !== "closed";
}

export class ManualContractService {
  private readonly validateSchema: ValidateFunction;

  constructor(
    schema: object,
    private readonly registry: FeatureRegistry,
    private readonly repository: ContractRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly constraintIdFactory: ConstraintIdFactory = createUlid,
  ) {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
    });
    addFormats(ajv);
    this.validateSchema = ajv.compile(schema);
  }

  private validate(document: AccessContractDocument): void {
    const schemaValid = this.validateSchema(document);
    const schemaIssues = schemaValid
      ? []
      : (this.validateSchema.errors ?? []).map(
          (error) =>
            `schema:${error.instancePath || "/"}:${error.message ?? "invalid"}`,
        );
    if (!schemaValid)
      throw new Error(
        `contract_validation_failed:${schemaIssues.sort().join(",")}`,
      );
    const issues = validateAccessContractSemantics(document);
    const registered = new Set(
      this.registry.features.map((feature) => feature.key),
    );
    for (const constraint of document.constraints) {
      if (!registered.has(constraint.predicate.feature)) {
        issues.push(`unregistered_predicate:${constraint.constraint_id}`);
      }
    }
    if (document.provenance !== "fixture")
      issues.push("local_service_requires_fixture_provenance");
    if (issues.length > 0)
      throw new Error(
        `contract_validation_failed:${[...new Set(issues)].sort().join(",")}`,
      );
  }

  private view(document: AccessContractDocument): ContractView {
    return {
      contract: structuredClone(document),
      monitoring_authorized: monitoringEnabled(document),
      provenance: "fixture",
    };
  }

  private async current(
    tripId: string,
    actorTravelerId: string,
  ): Promise<AccessContractDocument> {
    const document = await this.repository.current(tripId);
    if (!document) throw new Error("trip_not_found");
    if (document.traveler_id !== actorTravelerId)
      throw new Error("trip_access_denied");
    this.validate(document);
    return document;
  }

  async importManual(
    document: AccessContractDocument,
    actorTravelerId: string,
  ): Promise<ContractView> {
    if (document.traveler_id !== actorTravelerId)
      throw new Error("trip_access_denied");
    if (document.status !== "draft")
      throw new Error("manual_import_must_start_as_draft");
    if (document.trip.source !== "manual")
      throw new Error("manual_import_requires_manual_source");
    if (document.version !== 1)
      throw new Error("manual_import_must_start_at_version_one");
    this.validate(document);
    await this.repository.append(document, null);
    return this.view(document);
  }

  /**
   * Records a traveler-authored requirement on the current draft. The caller
   * must provide an explicit registered predicate and selected asset IDs;
   * wording is not paraphrased and no evidence or accessibility claim is added.
   */
  async captureConstraint(
    input: CaptureConstraintInput,
  ): Promise<ContractView> {
    const current = await this.current(input.tripId, input.actorTravelerId);
    if (current.version !== input.expectedVersion)
      throw new Error("optimistic_version_conflict");
    if (current.status !== "draft")
      throw new Error("only_draft_contracts_can_capture_constraints");

    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("invalid_constraint_capture_clock");
    const constraintId = this.constraintIdFactory(now);
    if (
      current.constraints.some((item) => item.constraint_id === constraintId)
    ) {
      throw new Error("constraint_id_already_exists");
    }
    const constraint = createAccessConstraint(input.constraint, {
      constraint_id: constraintId,
      assets: current.assets,
      registry: this.registry,
    });
    const captured: AccessContractDocument = {
      ...structuredClone(current),
      constraints: [...current.constraints, constraint],
      version: current.version + 1,
      updated_at: now.toISOString(),
    };
    this.validate(captured);
    await this.repository.append(captured, current.version);
    return this.view(captured);
  }

  async correctDraft(input: {
    tripId: string;
    actorTravelerId: string;
    expectedVersion: number;
    document: AccessContractDocument;
  }): Promise<ContractView> {
    const current = await this.current(input.tripId, input.actorTravelerId);
    if (current.version !== input.expectedVersion)
      throw new Error("optimistic_version_conflict");
    if (current.status !== "draft")
      throw new Error("only_draft_contracts_can_be_corrected");
    const corrected = structuredClone(input.document);
    if (
      corrected.contract_id !== current.contract_id ||
      corrected.trip.trip_id !== current.trip.trip_id ||
      corrected.traveler_id !== current.traveler_id
    ) {
      throw new Error("contract_identity_cannot_change");
    }
    if (corrected.status !== "draft")
      throw new Error("draft_correction_must_remain_draft");
    if (corrected.trip.source !== "manual")
      throw new Error("draft_correction_requires_manual_source");
    if (corrected.provenance !== "fixture")
      throw new Error("local_service_requires_fixture_provenance");
    corrected.created_at = current.created_at;
    corrected.updated_at = this.clock().toISOString();
    corrected.version = current.version + 1;
    this.validate(corrected);
    await this.repository.append(corrected, current.version);
    return this.view(corrected);
  }

  async activate(input: {
    tripId: string;
    actorTravelerId: string;
    expectedVersion: number;
    approvedContractVersion: number;
  }): Promise<ContractView> {
    const current = await this.current(input.tripId, input.actorTravelerId);
    if (current.version !== input.expectedVersion)
      throw new Error("optimistic_version_conflict");
    if (input.approvedContractVersion !== current.version)
      throw new Error("approved_contract_version_is_stale");
    if (current.status !== "draft")
      throw new Error("contract_already_activated");
    const evaluation = evaluateAccessContract({
      document: current,
      registry: this.registry,
      now: this.clock(),
      allowFixture: true,
    });
    if (evaluation.status === "violated")
      throw new Error("violated_contract_cannot_be_activated");
    const activated: AccessContractDocument = {
      ...structuredClone(current),
      status: evaluation.status,
      version: current.version + 1,
      updated_at: this.clock().toISOString(),
    };
    this.validate(activated);
    await this.repository.append(activated, current.version);
    return this.view(activated);
  }

  async getTrip(
    tripId: string,
    actorTravelerId: string,
  ): Promise<ContractView> {
    return this.view(await this.current(tripId, actorTravelerId));
  }

  async versionHistory(
    tripId: string,
    actorTravelerId: string,
  ): Promise<AccessContractDocument[]> {
    await this.current(tripId, actorTravelerId);
    return this.repository.versions(tripId);
  }

  async exportTrip(
    tripId: string,
    actorTravelerId: string,
  ): Promise<TripContractExport> {
    const current = await this.current(tripId, actorTravelerId);
    const exportedAt = this.clock();
    if (!Number.isFinite(exportedAt.getTime()))
      throw new Error("invalid_contract_export_clock");
    return {
      export_version: 1,
      trip_id: current.trip.trip_id,
      exported_at: exportedAt.toISOString(),
      provenance: "fixture",
      contract_versions: await this.repository.versions(tripId),
    };
  }

  async revokeMonitoring(input: {
    tripId: string;
    actorTravelerId: string;
    expectedVersion: number;
  }): Promise<ContractView> {
    const current = await this.current(input.tripId, input.actorTravelerId);
    if (current.version !== input.expectedVersion)
      throw new Error("optimistic_version_conflict");
    if (current.status === "closed") return this.view(current);
    if (current.status === "draft") throw new Error("monitoring_not_active");
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("invalid_monitoring_revocation_clock");
    const revoked: AccessContractDocument = {
      ...structuredClone(current),
      status: "closed",
      version: current.version + 1,
      updated_at: now.toISOString(),
    };
    this.validate(revoked);
    await this.repository.append(revoked, current.version);
    return this.view(revoked);
  }
}
