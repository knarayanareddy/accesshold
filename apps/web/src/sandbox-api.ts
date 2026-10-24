import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";
import {
  createFixtureRuntime,
  type FixtureRuntime,
} from "../../../services/api/src/fixture-runtime.js";
import type { RecoveryCase } from "./api.js";

export interface SandboxRequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

type JsonRecord = Record<string, unknown>;

function httpError(
  statusCode: number,
  message: string,
): Error & {
  statusCode: number;
} {
  return Object.assign(new Error(message), { statusCode });
}

function parseBody(options: SandboxRequestOptions): JsonRecord {
  if (typeof options.body !== "string" || options.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.body) as unknown;
  } catch {
    throw httpError(400, "request_validation_failed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw httpError(400, "request_validation_failed");
  return parsed as JsonRecord;
}

function stringField(body: JsonRecord, name: string): string {
  const value = body[name];
  if (typeof value !== "string")
    throw httpError(400, "request_validation_failed");
  return value;
}

function numberField(body: JsonRecord, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw httpError(400, "request_validation_failed");
  return value;
}

function tripSummary(document: AccessContractDocument, cases: RecoveryCase[]) {
  return {
    trip_id: document.trip.trip_id,
    title: document.trip.title,
    starts_at: document.trip.starts_at,
    ends_at: document.trip.ends_at,
    status: document.status,
    contract_version: document.version,
    open_case_count: cases.filter((item) => item.state === "detected").length,
    monitoring_authorized:
      document.status !== "draft" && document.status !== "closed",
    provenance: "fixture" as const,
  };
}

async function listTrips(runtime: FixtureRuntime) {
  const trips = [];
  for (const document of await runtime.repository.listCurrentForTraveler(
    runtime.actorTravelerId,
  )) {
    if (document.traveler_id !== runtime.actorTravelerId) continue;
    const view = await runtime.contracts.getTrip(
      document.trip.trip_id,
      runtime.actorTravelerId,
    );
    const cases = await runtime.monitor.cases(
      document.trip.trip_id,
      runtime.actorTravelerId,
    );
    trips.push(tripSummary(view.contract, cases));
  }
  return {
    trips,
    as_of: runtime.demoClock().toISOString(),
    provenance: "fixture" as const,
  };
}

async function tripDetails(runtime: FixtureRuntime, tripId: string) {
  const view = await runtime.contracts.getTrip(tripId, runtime.actorTravelerId);
  const cases = await runtime.monitor.cases(tripId, runtime.actorTravelerId);
  return { ...view, cases, as_of: runtime.demoClock().toISOString() };
}

async function evidence(runtime: FixtureRuntime, tripId: string) {
  const view = await runtime.contracts.getTrip(tripId, runtime.actorTravelerId);
  return {
    trip_id: tripId,
    items: view.contract.evidence.map((item) => ({
      evidence_id: item.evidence_id,
      asset_id: item.asset_id,
      source_type: item.source_type,
      verification_level: item.verification_level,
      observed_at: item.observed_at,
      expires_at: item.expires_at ?? null,
      features: item.features.map((feature) => ({
        key: feature.key,
        value_type: typeof feature.value,
        value: typeof feature.value === "string" ? null : feature.value,
        unit: feature.unit ?? null,
      })),
      provenance: item.provenance,
    })),
    provenance: "fixture" as const,
  };
}

async function recoveryOptions(runtime: FixtureRuntime, caseId: string) {
  const actorTravelerId = runtime.actorTravelerId;
  const found = await runtime.findCase({ caseId, actorTravelerId });
  const options = await runtime.listRecoveryOptions({
    caseId,
    tripId: found.document.trip.trip_id,
    actorTravelerId,
  });
  return {
    case_id: caseId,
    option_set_version: found.document.version,
    options: options.map((option) => ({
      option_id: option.option_id,
      summary: option.summary,
      action: option.action,
      amount_minor: option.amount_minor,
      currency: option.currency,
      terms: option.terms,
      expires_at: option.expires_at,
      unknowns: option.unknowns,
    })),
    no_action: {
      option_id: "no_action" as const,
      summary: "Keep the current itinerary; do not execute a recovery action.",
    },
    provenance: "fixture" as const,
  };
}

async function handleRequest(
  runtime: FixtureRuntime,
  pathname: string,
  options: SandboxRequestOptions,
): Promise<unknown> {
  const method = (options.method ?? "GET").toUpperCase();
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const body = parseBody(options);
  const actorTravelerId = runtime.actorTravelerId;

  if (parts.join("/") === "api/v1/trips" && method === "GET")
    return listTrips(runtime);

  if (parts[0] !== "api" || parts[1] !== "v1")
    throw httpError(404, "route_not_found");

  if (parts[2] === "trips" && parts.length === 4) {
    const tripId = parts[3]!;
    if (method === "GET") return tripDetails(runtime, tripId);
    if (method === "DELETE") {
      const result = await runtime.deletion.requestDeletion({
        tripId,
        actorTravelerId,
        expectedContractVersion: numberField(body, "expected_contract_version"),
        confirmationPhrase: stringField(body, "confirmation_phrase"),
      });
      return { task: result.task, duplicate: result.duplicate };
    }
  }

  if (parts[2] === "trips" && parts.length === 5) {
    const tripId = parts[3]!;
    const action = parts[4]!;
    if (action === "evidence" && method === "GET")
      return evidence(runtime, tripId);
    if (action === "export" && method === "GET")
      return runtime.contracts.exportTrip(tripId, actorTravelerId);
    if (action === "cases" && method === "GET")
      return {
        cases: await runtime.monitor.cases(tripId, actorTravelerId),
        provenance: "fixture",
      };
    if (action === "provider-questions" && method === "GET") {
      const view = await runtime.contracts.getTrip(tripId, actorTravelerId);
      return {
        questions: view.contract.constraints.map((constraint) => ({
          constraint_id: constraint.constraint_id,
          status: constraint.status,
          feature: constraint.predicate.feature,
          applies_to: constraint.applies_to,
        })),
        provenance: "fixture",
      };
    }
    if (action === "provider-questions" && method === "POST")
      return runtime.providerQuestions.draftRequest({
        tripId,
        actorTravelerId,
        expectedContractVersion: numberField(body, "expected_contract_version"),
        constraintId: stringField(body, "constraint_id"),
        assetId: stringField(body, "asset_id"),
        recipient: stringField(body, "recipient"),
        idempotencyKey: stringField(body, "idempotency_key"),
      });
    if (action === "contract" && method === "PUT")
      return runtime.contracts.activate({
        tripId,
        actorTravelerId,
        expectedVersion: numberField(body, "expected_version"),
        approvedContractVersion: numberField(body, "approved_contract_version"),
      });
    if (action === "draft" && method === "PATCH")
      return runtime.contracts.correctDraft({
        tripId,
        actorTravelerId,
        expectedVersion: numberField(body, "expected_version"),
        document: body.document as AccessContractDocument,
      });
    if (action === "revoke-monitoring" && method === "POST")
      return runtime.contracts.revokeMonitoring({
        tripId,
        actorTravelerId,
        expectedVersion: numberField(body, "expected_version"),
      });
    if (action === "retention-extension" && method === "POST")
      return runtime.deletion.extendRetention({
        tripId,
        actorTravelerId,
        expectedContractVersion: numberField(body, "expected_contract_version"),
        retainUntil: stringField(body, "retain_until"),
      });
  }

  if (parts[2] === "cases" && parts.length === 5) {
    const caseId = parts[3]!;
    if (parts[4] === "options" && method === "GET")
      return recoveryOptions(runtime, caseId);
    if (parts[4] === "options" && method === "POST") {
      const found = await runtime.findCase({ caseId, actorTravelerId });
      const expectedVersion = numberField(body, "expected_version");
      if (found.document.version !== expectedVersion)
        throw httpError(409, "optimistic_version_conflict");
      const optionsForCase = await runtime.listRecoveryOptions({
        caseId,
        tripId: found.document.trip.trip_id,
        actorTravelerId,
      });
      const option = optionsForCase.find(
        (item) => item.option_id === stringField(body, "option_id"),
      );
      if (!option) throw httpError(404, "recovery_option_not_found");
      const offered = runtime.recovery.offerPlans({
        document: found.document,
        caseId,
        options: [option],
      });
      const plan = offered.plans[0];
      if (!plan) throw httpError(500, "recovery_plan_not_created");
      return {
        plan_id: plan.plan_hash,
        plan_sha256: plan.plan_hash,
        plan,
        provenance: "fixture",
      };
    }
    if (parts[4] === "handoff" && method === "POST") {
      const found = await runtime.findCase({ caseId, actorTravelerId });
      const callbackPreference = stringField(body, "callback_preference");
      if (!["email", "phone", "none"].includes(callbackPreference))
        throw httpError(400, "request_validation_failed");
      const unknowns = found.document.constraints
        .filter(
          (constraint) =>
            constraint.priority === "hard" &&
            constraint.status === "unverified",
        )
        .map(
          (constraint) =>
            `Hard requirement ${constraint.constraint_id} remains unverified.`,
        );
      const handoff = runtime.handoff.requestHandoff({
        document: found.document,
        caseId,
        actorTravelerId,
        reason: `Traveler requested specialist follow-up; callback preference: ${callbackPreference}.`,
        unknowns,
      });
      return {
        handoff_id: handoff.packet.packet_id,
        status: "fixture_packet_ready_not_sent",
        callback_preference: callbackPreference,
        duplicate: handoff.duplicate,
        live_handoff: false,
        provenance: "fixture",
      };
    }
  }

  if (
    parts[2] === "provider-questions" &&
    parts.length === 5 &&
    parts[4] === "approve" &&
    method === "POST"
  ) {
    return runtime.providerQuestions.approveAndSend({
      requestId: parts[3]!,
      actorTravelerId,
      expectedContractVersion: numberField(body, "expected_contract_version"),
      approvedHash: stringField(body, "approval_hash"),
    });
  }

  if (parts[2] === "plans" && parts.length === 5) {
    const planId = parts[3]!;
    const action = parts[4]!;
    if (action === "approvals" && method === "POST") {
      if (stringField(body, "plan_sha256") !== planId)
        throw httpError(409, "approval_plan_hash_mismatch");
      if (stringField(body, "approval_phrase") !== "APPROVE RECOVERY")
        throw httpError(400, "recovery_approval_phrase_mismatch");
      const plan = runtime.recovery.getPlan(planId);
      const view = await runtime.contracts.getTrip(
        plan.trip_id,
        actorTravelerId,
      );
      const approval = runtime.recovery.approve({
        document: view.contract,
        planHash: planId,
        actorTravelerId,
        method: "web",
        recentAuthentication: true,
      });
      return {
        approval,
        plan: runtime.recovery.getPlan(planId),
        provenance: "fixture",
      };
    }
    if (action === "execute" && method === "POST") {
      const planHash = stringField(body, "plan_sha256");
      if (planHash !== planId)
        throw httpError(409, "approval_plan_hash_mismatch");
      return {
        ...runtime.recovery.execute({
          approvalPlanHash: planId,
          submittedPlanHash: planHash,
          actorTravelerId,
        }),
        provenance: "fixture",
      };
    }
  }

  if (parts[2] === "tasks" && parts.length === 4 && method === "GET") {
    const task = runtime.deletion.getTask(parts[3]!);
    if (task.requested_by !== actorTravelerId)
      throw httpError(404, "task_not_found");
    return { task, provenance: "fixture" };
  }

  if (
    parts[2] === "tasks" &&
    parts.length === 5 &&
    parts[4] === "run" &&
    method === "POST"
  ) {
    const taskId = parts[3]!;
    const task = runtime.deletion.getTask(taskId);
    if (task.requested_by !== actorTravelerId)
      throw httpError(404, "task_not_found");
    return runtime.deletion.runTask(taskId);
  }

  throw httpError(404, "route_not_found");
}

/** Builds an adapter over the existing fixture services without opening sockets. */
export function createSandboxApiAdapter(runtime: FixtureRuntime) {
  return async function sandboxApiRequest<T>(
    path: string,
    options: SandboxRequestOptions = {},
  ): Promise<T> {
    const url = new URL(path, "https://accesshold-sandbox.invalid");
    return (await handleRequest(runtime, url.pathname, options)) as T;
  };
}

let runtimePromise: Promise<FixtureRuntime> | undefined;

/** Uses the same in-memory runtime and fixture data as the Fastify local API. */
export async function sandboxApiRequest<T>(
  path: string,
  options: SandboxRequestOptions = {},
): Promise<T> {
  runtimePromise ??= createFixtureRuntime();
  const runtime = await runtimePromise;
  return createSandboxApiAdapter(runtime)<T>(path, options);
}
