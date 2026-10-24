import { createHash, randomBytes } from "node:crypto";
import type {
  AccessAsset,
  AccessContractDocument,
} from "../../../packages/contracts/src/index.js";
import { validateAccessContractSemantics } from "../../../packages/contracts/src/index.js";
import { createAccessConstraint } from "../../../packages/domain/src/index.js";
import type { FeatureRegistry } from "../../../packages/policy-engine/src/index.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ContractRepository } from "./contract-repository.js";
import type {
  ConfirmationConstraintPipeline,
  ParsedSesEmail,
  SesConfirmationImportResult,
} from "./ses-parser.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ExtractedBookingAsset {
  kind: AccessAsset["kind"];
  provider: string;
  provider_reference: string;
  starts_at: string;
  ends_at: string;
}

export interface ExtractedBookingItinerary {
  title: string;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  assets: ExtractedBookingAsset[];
}

export interface ConfirmationItineraryExtractor {
  extract(input: {
    travelerId: string;
    confirmationKind: Exclude<ParsedSesEmail["confirmation_kind"], "unknown">;
    subject: string;
    plainText: string;
    contentSha256: string;
  }): Promise<ExtractedBookingItinerary>;
}

export interface TravelerConstraintTemplate {
  traveler_text: string;
  priority: "hard" | "preference";
  predicate: AccessContractDocument["constraints"][number]["predicate"];
  applies_to_kinds: AccessAsset["kind"][];
}

export interface TravelerImportProfile {
  constraints: TravelerConstraintTemplate[];
  approval_policy: AccessContractDocument["approval_policy"];
}

export interface TravelerImportProfileProvider {
  getProfile(travelerId: string): Promise<TravelerImportProfile>;
}

export interface SesConfirmationPipelineOptions {
  schema: object;
  registry: FeatureRegistry;
  repository: ContractRepository;
  profileProvider: TravelerImportProfileProvider;
  itineraryExtractor: ConfirmationItineraryExtractor;
  clock?: () => Date;
  idFactory?: (at: Date) => string;
  tripIdFactory?: (receivedAt: Date, idempotencyKey: string) => string;
}

function encodeUlid(value: bigint): string {
  let remaining = value;
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = `${ULID_ALPHABET[Number(remaining & 31n)]!}${result}`;
    remaining >>= 5n;
  }
  return result;
}

function createUlid(at: Date): string {
  const milliseconds = at.getTime();
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 0xffffffffffff
  ) {
    throw new Error("ses_import_clock_invalid");
  }
  const randomness = BigInt(`0x${randomBytes(10).toString("hex")}`);
  return encodeUlid((BigInt(milliseconds) << 80n) | randomness);
}

function createStableTripId(receivedAt: Date, idempotencyKey: string): string {
  const milliseconds = receivedAt.getTime();
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 0xffffffffffff
  ) {
    throw new Error("ses_import_received_at_invalid");
  }
  const randomness = BigInt(
    `0x${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20)}`,
  );
  return encodeUlid((BigInt(milliseconds) << 80n) | randomness);
}

function matchingDuplicate(
  document: AccessContractDocument,
  travelerId: string,
  email: ParsedSesEmail,
): boolean {
  return (
    document.traveler_id === travelerId &&
    document.trip.source === "confirmation_email" &&
    document.provenance === "live" &&
    document.evidence.some(
      (item) =>
        item.content_sha256 === email.content_sha256 &&
        item.source_uri === email.source_uri,
    )
  );
}

/**
 * Turns a parsed confirmation into a schema-validated draft using only the
 * traveler’s pre-existing constraint profile. Extracted text never creates or
 * edits an accessibility constraint and never activates monitoring.
 */
export class SesConfirmationConstraintPipeline
  implements ConfirmationConstraintPipeline
{
  private readonly validateSchema: ReturnType<Ajv2020["compile"]>;
  private readonly clock: () => Date;
  private readonly idFactory: (at: Date) => string;
  private readonly tripIdFactory: (
    receivedAt: Date,
    idempotencyKey: string,
  ) => string;

  constructor(private readonly options: SesConfirmationPipelineOptions) {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
    });
    addFormats(ajv);
    this.validateSchema = ajv.compile(options.schema);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? createUlid;
    this.tripIdFactory = options.tripIdFactory ?? createStableTripId;
  }

  async ingestConfirmation(input: {
    travelerId: string;
    email: ParsedSesEmail;
    idempotencyKey: string;
  }): Promise<SesConfirmationImportResult> {
    const { email, travelerId, idempotencyKey } = input;
    if (
      !/^[0-9a-f]{64}$/.test(idempotencyKey) ||
      idempotencyKey !== email.idempotency_key
    ) {
      throw new Error("ses_import_idempotency_key_invalid");
    }
    if (!email.source_uri?.startsWith("s3://"))
      throw new Error("ses_import_source_uri_required");
    if (email.manual_review_reasons.length > 0)
      throw new Error("ses_import_requires_manual_review");
    if (!/^[0-9a-f]{64}$/.test(email.content_sha256))
      throw new Error("ses_import_content_hash_invalid");
    if (email.confirmation_kind === "unknown")
      throw new Error("ses_confirmation_kind_unsupported");
    const receivedAt = new Date(email.received_at);
    if (!Number.isFinite(receivedAt.getTime()))
      throw new Error("ses_import_received_at_invalid");

    const tripId = this.tripIdFactory(receivedAt, idempotencyKey);
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(tripId))
      throw new Error("ses_import_trip_id_invalid");
    const existing = await this.options.repository.current(tripId);
    if (existing) {
      if (!matchingDuplicate(existing, travelerId, email))
        throw new Error("ses_import_trip_identity_conflict");
      return {
        status: "duplicate",
        tripId,
        contractVersion: existing.version,
        contractStatus: existing.status,
      };
    }

    const profile = await this.options.profileProvider.getProfile(travelerId);
    const extracted = await this.options.itineraryExtractor.extract({
      travelerId,
      confirmationKind: email.confirmation_kind,
      subject: email.subject,
      plainText: email.text_body,
      contentSha256: email.content_sha256,
    });
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("ses_import_clock_invalid");
    if (!Array.isArray(extracted.assets) || extracted.assets.length === 0)
      throw new Error("ses_import_assets_missing");
    const assets: AccessAsset[] = extracted.assets.map((asset) => ({
      asset_id: this.idFactory(now),
      kind: asset.kind,
      provider: asset.provider,
      provider_reference: asset.provider_reference,
      starts_at: asset.starts_at,
      ends_at: asset.ends_at,
      attributes: [],
    }));
    const constraints = profile.constraints.flatMap((template) => {
      const appliesTo = assets
        .filter((asset) => template.applies_to_kinds.includes(asset.kind))
        .map((asset) => asset.asset_id);
      if (appliesTo.length === 0) return [];
      return [
        createAccessConstraint(
          {
            traveler_text: template.traveler_text,
            priority: template.priority,
            applies_to: appliesTo,
            predicate: template.predicate,
          },
          {
            constraint_id: this.idFactory(now),
            assets,
            registry: this.options.registry,
          },
        ),
      ];
    });
    if (constraints.length === 0)
      throw new Error("ses_import_no_applicable_traveler_constraints");

    const evidence = assets.map((asset) => ({
      evidence_id: this.idFactory(now),
      asset_id: asset.asset_id,
      source_type: "provider_document" as const,
      verification_level: "documented" as const,
      features: [],
      source_uri: email.source_uri!,
      content_sha256: email.content_sha256,
      observed_at: email.received_at,
      provenance: "live" as const,
    }));
    const document: AccessContractDocument = {
      schema_version: 1,
      contract_id: this.idFactory(now),
      traveler_id: travelerId,
      trip: {
        trip_id: tripId,
        title: extracted.title,
        starts_at: extracted.starts_at,
        ends_at: extracted.ends_at,
        time_zone: extracted.time_zone,
        source: "confirmation_email",
      },
      assets,
      constraints,
      evidence,
      approval_policy: structuredClone(profile.approval_policy),
      status: "draft",
      provenance: "live",
      version: 1,
      created_at: email.received_at,
      updated_at: email.received_at,
    };
    const schemaValid = this.validateSchema(document);
    if (!schemaValid) throw new Error("ses_import_contract_schema_invalid");
    const semanticIssues = validateAccessContractSemantics(document);
    if (semanticIssues.length > 0)
      throw new Error("ses_import_contract_semantics_invalid");

    try {
      await this.options.repository.append(document, null);
      return {
        status: "imported",
        tripId,
        contractVersion: 1,
        contractStatus: "draft",
      };
    } catch (error) {
      if (
        error instanceof Error &&
        ["trip_already_exists", "contract_version_already_exists"].includes(
          error.message,
        )
      ) {
        const raced = await this.options.repository.current(tripId);
        if (raced && matchingDuplicate(raced, travelerId, email)) {
          return {
            status: "duplicate",
            tripId,
            contractVersion: raced.version,
            contractStatus: raced.status,
          };
        }
        throw new Error("ses_import_trip_identity_conflict", { cause: error });
      }
      throw error;
    }
  }
}
