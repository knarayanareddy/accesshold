export const LOCAL_FIXTURE_TOKEN = "accesshold-local-demo-token";

export interface TripSummary {
  trip_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  status: string;
  contract_version: number;
  open_case_count: number;
  monitoring_authorized: boolean;
  provenance: "fixture";
}

export interface TripDetails {
  contract: import("../../../packages/contracts/src/index.js").AccessContractDocument;
  monitoring_authorized: boolean;
  provenance: "fixture";
  cases: RecoveryCase[];
  as_of: string;
}

export interface RecoveryCase {
  case_id: string;
  trip_id: string;
  state: "detected" | "completed";
  version: number;
  constraint_ids: string[];
  opened_at: string;
  updated_at: string;
  timeline: Array<{
    code: string;
    recorded_at: string;
    constraint_ids: string[];
  }>;
}

export interface EvidenceItem {
  evidence_id: string;
  asset_id: string;
  source_type: string;
  verification_level: string;
  observed_at: string;
  expires_at: string | null;
  features: Array<{
    key: string;
    value_type: string;
    value: string | number | boolean | null;
    unit: string | null;
  }>;
  provenance: "fixture" | "live";
}

export interface RecoveryOption {
  option_id: string;
  summary: string;
  action: "sandbox_rebook";
  amount_minor: number;
  currency: string;
  terms: string;
  expires_at: string;
  unknowns: string[];
}

export interface RecoveryOptionsResponse {
  case_id: string;
  option_set_version: number;
  options: RecoveryOption[];
  no_action: { option_id: "no_action"; summary: string };
  provenance: "fixture";
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${LOCAL_FIXTURE_TOKEN}`);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String(body.error ?? "request_failed")
        : "request_failed";
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
