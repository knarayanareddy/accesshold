export type Provenance = "live" | "fixture";
export type SourceType =
  | "official_api"
  | "provider_written"
  | "provider_document"
  | "traveler_supplied"
  | "review"
  | "fixture";
export type VerificationLevel =
  | "provider_confirmed"
  | "documented"
  | "unverified";
export type FeatureValue = string | number | boolean | null;

export interface Feature {
  key: string;
  value: FeatureValue;
  unit?: string;
  confidence?: number;
}

export interface Predicate {
  feature: string;
  operator: "eq" | "neq" | "gte" | "lte" | "in" | "exists";
  value: string | number | boolean | Array<string | number | boolean>;
  unit?: string;
}

export interface AccessAsset {
  asset_id: string;
  kind: "flight" | "seat" | "hotel_room" | "ground_transfer";
  provider: string;
  provider_reference: string;
  starts_at: string;
  ends_at: string;
  parent_asset_id?: string;
  attributes: Feature[];
}

export interface AccessConstraint {
  constraint_id: string;
  traveler_text: string;
  priority: "hard" | "preference";
  applies_to: string[];
  predicate: Predicate;
  status:
    | "provider_confirmed"
    | "documented"
    | "unverified"
    | "violated"
    | "not_applicable";
  evidence_ids: string[];
}

export interface AccessEvidence {
  evidence_id: string;
  asset_id: string;
  source_type: SourceType;
  verification_level: VerificationLevel;
  features: Feature[];
  source_uri?: string;
  content_sha256?: string;
  observed_at: string;
  expires_at?: string;
  provenance: Provenance;
}

export interface AccessContractDocument {
  schema_version: 1;
  contract_id: string;
  traveler_id: string;
  trip: {
    trip_id: string;
    title: string;
    starts_at: string;
    ends_at: string;
    time_zone: string;
    source: "confirmation_email" | "provider_api" | "manual" | "fixture";
  };
  assets: AccessAsset[];
  constraints: AccessConstraint[];
  evidence: AccessEvidence[];
  approval_policy: {
    allowed_actions: Array<
      | "send_provider_request"
      | "calendar_update"
      | "sandbox_rebook"
      | "live_rebook"
    >;
    max_additional_cost: { amount_minor: number; currency: string };
    voice_approval_allowed: boolean;
    human_handoff_contact: string;
  };
  status:
    | "draft"
    | "active"
    | "degraded"
    | "violated"
    | "recovering"
    | "closed";
  provenance: Provenance;
  version: number;
  created_at: string;
  updated_at: string;
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function isOrdered(start: string, end: string): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs;
}

/** Semantic checks that JSON Schema cannot express. Returns stable, non-sensitive codes. */
export function validateAccessContractSemantics(
  document: AccessContractDocument,
): string[] {
  const issues = new Set<string>();
  const assetIds = new Set(document.assets.map((asset) => asset.asset_id));
  const evidenceIds = new Set(
    document.evidence.map((item) => item.evidence_id),
  );

  for (const id of duplicateValues(
    document.assets.map((asset) => asset.asset_id),
  )) {
    issues.add(`duplicate_asset_id:${id}`);
  }
  for (const id of duplicateValues(
    document.evidence.map((item) => item.evidence_id),
  )) {
    issues.add(`duplicate_evidence_id:${id}`);
  }
  for (const id of duplicateValues(
    document.constraints.map((item) => item.constraint_id),
  )) {
    issues.add(`duplicate_constraint_id:${id}`);
  }

  if (!isOrdered(document.trip.starts_at, document.trip.ends_at))
    issues.add("trip_interval_invalid");
  if (
    !isOrdered(document.created_at, document.updated_at) &&
    document.created_at !== document.updated_at
  ) {
    issues.add("contract_timestamp_order_invalid");
  }

  for (const asset of document.assets) {
    if (!isOrdered(asset.starts_at, asset.ends_at))
      issues.add(`asset_interval_invalid:${asset.asset_id}`);
    if (asset.parent_asset_id && !assetIds.has(asset.parent_asset_id)) {
      issues.add(`missing_parent_asset:${asset.asset_id}`);
    }
  }

  for (const item of document.evidence) {
    if (!assetIds.has(item.asset_id))
      issues.add(`missing_evidence_asset:${item.evidence_id}`);
    if (
      item.source_type === "review" &&
      item.verification_level === "provider_confirmed"
    ) {
      issues.add(`review_cannot_be_provider_confirmed:${item.evidence_id}`);
    }
    if (item.expires_at && !isOrdered(item.observed_at, item.expires_at)) {
      issues.add(`evidence_interval_invalid:${item.evidence_id}`);
    }
    if (document.provenance === "live" && item.provenance === "fixture") {
      issues.add(`fixture_evidence_in_live_contract:${item.evidence_id}`);
    }
    if (document.provenance === "fixture" && item.provenance !== "fixture") {
      issues.add(`live_evidence_in_fixture_contract:${item.evidence_id}`);
    }
  }

  for (const constraint of document.constraints) {
    for (const assetId of constraint.applies_to) {
      if (!assetIds.has(assetId))
        issues.add(`missing_constraint_asset:${constraint.constraint_id}`);
    }
    for (const evidenceId of constraint.evidence_ids) {
      if (!evidenceIds.has(evidenceId))
        issues.add(`missing_constraint_evidence:${constraint.constraint_id}`);
    }
  }

  return [...issues].sort();
}
