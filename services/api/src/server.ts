import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import {
  createAccessHoldMcpServer,
  defaultMcpIdentityResolver,
} from "../../mcp/src/accesshold-mcp-server.js";
import {
  createFixtureRuntime,
  type FixtureRuntime,
} from "./fixture-runtime.js";
import type { ManualContractService } from "../../importer/src/manual-contract-service.js";

const versionedTripParams = z
  .object({ tripId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) })
  .strict();
const taskParams = z.object({ taskId: z.string().min(1).max(128) }).strict();
const requestParams = z.object({ requestId: z.string().uuid() }).strict();
const caseParams = z.object({ caseId: z.string().min(1).max(128) }).strict();
const planParams = z
  .object({ planId: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const draftCorrectionBody = z
  .object({
    expected_version: z.number().int().min(1),
    document: z.record(z.string(), z.unknown()),
  })
  .strict();
const activationBody = z
  .object({
    expected_version: z.number().int().min(1),
    approved_contract_version: z.number().int().min(1),
  })
  .strict();
const providerQuestionDraftBody = z
  .object({
    expected_contract_version: z.number().int().min(1),
    constraint_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    asset_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    recipient: z.string().email().max(320),
    idempotency_key: z.string().min(1).max(128),
  })
  .strict();
const providerQuestionApprovalBody = z
  .object({
    expected_contract_version: z.number().int().min(1),
    approval_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const selectRecoveryBody = z
  .object({
    option_id: z.string().min(1).max(128),
    expected_version: z.number().int().min(1),
  })
  .strict();
const approvalBody = z
  .object({
    plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    approval_phrase: z.string().min(1).max(64),
  })
  .strict();
const executionBody = z
  .object({
    plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const handoffBody = z
  .object({
    callback_preference: z.enum(["email", "phone", "none"]),
  })
  .strict();
const retentionBody = z
  .object({
    expected_contract_version: z.number().int().min(1),
    retain_until: z.string().datetime({ offset: true }),
  })
  .strict();
const deletionBody = z
  .object({
    expected_contract_version: z.number().int().min(1),
    confirmation_phrase: z.string().max(64),
  })
  .strict();

interface AuthenticatedRequest extends FastifyRequest {
  travelerId: string | null;
  recentAuthentication: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    travelerId: string | null;
    recentAuthentication: boolean;
  }
}

function httpError(
  statusCode: number,
  code: string,
): Error & { statusCode: number } {
  return Object.assign(new Error(code), { statusCode });
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw httpError(400, "request_validation_failed");
  return result.data;
}

function travelerId(request: FastifyRequest): string {
  const authenticated = request as AuthenticatedRequest;
  if (!authenticated.travelerId)
    throw httpError(401, "authentication_required");
  return authenticated.travelerId;
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^[a-z][a-z0-9_:-]{0,100}$/i.test(error.message)
  )
    return error.message;
  return "request_failed";
}

function requirePath<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw httpError(400, "path_validation_failed");
  return result.data;
}

function authenticateFixtureToken(
  authorization: string | undefined,
  expectedToken: string,
): AuthInfo {
  if (process.env.NODE_ENV === "production")
    throw httpError(503, "production_identity_provider_not_configured");
  const [scheme, token, ...extra] = (authorization ?? "").split(" ");
  if (
    scheme !== "Bearer" ||
    !token ||
    extra.length > 0 ||
    token !== expectedToken
  ) {
    throw httpError(401, "authentication_required");
  }
  return {
    token,
    clientId: "accesshold-local-fixture",
    scopes: ["accesshold:read", "accesshold:write"],
    extra: {
      travelerId: process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID ?? "",
      recentAuthentication: true,
      provenance: "fixture",
    },
  };
}

function currentIdentity(request: FastifyRequest): AuthInfo {
  const authenticated = request as AuthenticatedRequest;
  if (!authenticated.travelerId)
    throw httpError(401, "authentication_required");
  return {
    token: "local-fixture-token-redacted",
    clientId: "accesshold-local-fixture",
    scopes: ["accesshold:read", "accesshold:write"],
    extra: {
      travelerId: authenticated.travelerId,
      recentAuthentication: authenticated.recentAuthentication,
      provenance: "fixture",
    },
  };
}

export async function buildApiServer(
  runtimeInput?: FixtureRuntime,
): Promise<FastifyInstance> {
  const runtime = runtimeInput ?? (await createFixtureRuntime());
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
  });
  app.decorateRequest("travelerId", null);
  app.decorateRequest("recentAuthentication", false);

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/v1/") && request.url !== "/mcp") return;
    const info = authenticateFixtureToken(
      request.headers.authorization,
      process.env.ACCESSHOLD_FIXTURE_TOKEN ?? "accesshold-local-demo-token",
    );
    request.travelerId = String(
      info.extra?.travelerId || runtime.actorTravelerId,
    );
    request.recentAuthentication = info.extra?.recentAuthentication === true;
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 400;
    reply.code(statusCode).send({ error: safeErrorCode(error) });
  });

  app.get("/health", async () => ({
    status: "ok",
    provenance: "fixture",
    provider: "TEST PROVIDER",
  }));

  app.get("/api/v1/trips", async (request) => {
    const actor = travelerId(request);
    const trips = [];
    for (const document of await runtime.repository.listCurrent()) {
      if (document.traveler_id !== actor) continue;
      const view = await runtime.contracts.getTrip(
        document.trip.trip_id,
        actor,
      );
      const cases = await runtime.monitor.cases(document.trip.trip_id, actor);
      trips.push({
        trip_id: view.contract.trip.trip_id,
        title: view.contract.trip.title,
        starts_at: view.contract.trip.starts_at,
        ends_at: view.contract.trip.ends_at,
        status: view.contract.status,
        contract_version: view.contract.version,
        open_case_count: cases.filter((item) => item.state === "detected")
          .length,
        monitoring_authorized: view.monitoring_authorized,
        provenance: "fixture",
      });
    }
    return {
      trips,
      as_of: runtime.demoClock().toISOString(),
      provenance: "fixture",
    };
  });

  app.get<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const view = await runtime.contracts.getTrip(tripId, travelerId(request));
      const cases = await runtime.monitor.cases(tripId, travelerId(request));
      return { ...view, cases, as_of: runtime.demoClock().toISOString() };
    },
  );

  app.get<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/export",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      return runtime.contracts.exportTrip(tripId, travelerId(request));
    },
  );

  app.patch<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/draft",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const body = parseBody(draftCorrectionBody, request.body);
      const document = body.document as unknown as Awaited<
        ReturnType<ManualContractService["getTrip"]>
      >["contract"];
      return runtime.contracts.correctDraft({
        tripId,
        actorTravelerId: travelerId(request),
        expectedVersion: body.expected_version,
        document,
      });
    },
  );

  app.put<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/contract",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const body = parseBody(activationBody, request.body);
      return runtime.contracts.activate({
        tripId,
        actorTravelerId: travelerId(request),
        expectedVersion: body.expected_version,
        approvedContractVersion: body.approved_contract_version,
      });
    },
  );

  app.post<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/revoke-monitoring",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const body = parseBody(
        z.object({ expected_version: z.number().int().min(1) }).strict(),
        request.body,
      );
      return runtime.contracts.revokeMonitoring({
        tripId,
        actorTravelerId: travelerId(request),
        expectedVersion: body.expected_version,
      });
    },
  );

  app.get<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/evidence",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const view = await runtime.contracts.getTrip(tripId, travelerId(request));
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
        provenance: "fixture",
      };
    },
  );

  app.get<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/cases",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      return {
        cases: await runtime.monitor.cases(tripId, travelerId(request)),
        provenance: "fixture",
      };
    },
  );

  app.get<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/provider-questions",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const view = await runtime.contracts.getTrip(tripId, travelerId(request));
      return {
        questions: view.contract.constraints.map((constraint) => ({
          constraint_id: constraint.constraint_id,
          status: constraint.status,
          feature: constraint.predicate.feature,
          applies_to: constraint.applies_to,
        })),
        provenance: "fixture",
      };
    },
  );

  app.post<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/provider-questions",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const body = parseBody(providerQuestionDraftBody, request.body);
      return runtime.providerQuestions.draftRequest({
        tripId,
        actorTravelerId: travelerId(request),
        expectedContractVersion: body.expected_contract_version,
        constraintId: body.constraint_id,
        assetId: body.asset_id,
        recipient: body.recipient,
        idempotencyKey: body.idempotency_key,
      });
    },
  );

  app.post<{ Params: { requestId: string } }>(
    "/api/v1/provider-questions/:requestId/approve",
    async (request) => {
      const { requestId } = requirePath(requestParams, request.params);
      const body = parseBody(providerQuestionApprovalBody, request.body);
      return runtime.providerQuestions.approveAndSend({
        requestId,
        actorTravelerId: travelerId(request),
        expectedContractVersion: body.expected_contract_version,
        approvedHash: body.approval_hash,
      });
    },
  );

  app.get<{ Params: { caseId: string } }>(
    "/api/v1/cases/:caseId/options",
    async (request) => {
      const { caseId } = requirePath(caseParams, request.params);
      const actor = travelerId(request);
      const found = await runtime.findCase({ caseId, actorTravelerId: actor });
      const options = await runtime.listRecoveryOptions({
        caseId,
        tripId: found.document.trip.trip_id,
        actorTravelerId: actor,
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
          option_id: "no_action",
          summary:
            "Keep the current itinerary; do not execute a recovery action.",
        },
        provenance: "fixture",
      };
    },
  );

  app.post<{ Params: { caseId: string } }>(
    "/api/v1/cases/:caseId/options",
    async (request) => {
      const { caseId } = requirePath(caseParams, request.params);
      const body = parseBody(selectRecoveryBody, request.body);
      const actor = travelerId(request);
      const found = await runtime.findCase({ caseId, actorTravelerId: actor });
      if (found.document.version !== body.expected_version)
        throw httpError(409, "optimistic_version_conflict");
      const options = await runtime.listRecoveryOptions({
        caseId,
        tripId: found.document.trip.trip_id,
        actorTravelerId: actor,
      });
      const option = options.find((item) => item.option_id === body.option_id);
      if (!option) throw httpError(404, "recovery_option_not_found");
      const result = runtime.recovery.offerPlans({
        document: found.document,
        caseId,
        options: [option],
      });
      const plan = result.plans[0];
      if (!plan) throw httpError(500, "recovery_plan_not_created");
      return {
        plan_id: plan.plan_hash,
        plan_sha256: plan.plan_hash,
        plan,
        provenance: "fixture",
      };
    },
  );

  app.post<{ Params: { planId: string } }>(
    "/api/v1/plans/:planId/approvals",
    async (request) => {
      const { planId } = requirePath(planParams, request.params);
      const body = parseBody(approvalBody, request.body);
      if (body.plan_sha256 !== planId)
        throw httpError(409, "approval_plan_hash_mismatch");
      if (body.approval_phrase !== "APPROVE RECOVERY")
        throw httpError(400, "recovery_approval_phrase_mismatch");
      const plan = runtime.recovery.getPlan(planId);
      const actor = travelerId(request);
      const view = await runtime.contracts.getTrip(plan.trip_id, actor);
      const authenticated = request as AuthenticatedRequest;
      const approval = runtime.recovery.approve({
        document: view.contract,
        planHash: planId,
        actorTravelerId: actor,
        method: "web",
        recentAuthentication: authenticated.recentAuthentication,
      });
      return {
        approval,
        plan: runtime.recovery.getPlan(planId),
        provenance: "fixture",
      };
    },
  );

  app.post<{ Params: { planId: string } }>(
    "/api/v1/plans/:planId/execute",
    async (request) => {
      const { planId } = requirePath(planParams, request.params);
      const body = parseBody(executionBody, request.body);
      const actor = travelerId(request);
      if (body.plan_sha256 !== planId)
        throw httpError(409, "approval_plan_hash_mismatch");
      const execution = runtime.recovery.execute({
        approvalPlanHash: planId,
        submittedPlanHash: body.plan_sha256,
        actorTravelerId: actor,
      });
      return { ...execution, provenance: "fixture" };
    },
  );

  app.post<{ Params: { caseId: string } }>(
    "/api/v1/cases/:caseId/handoff",
    async (request) => {
      const { caseId } = requirePath(caseParams, request.params);
      const body = parseBody(handoffBody, request.body);
      const actor = travelerId(request);
      const found = await runtime.findCase({ caseId, actorTravelerId: actor });
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
        actorTravelerId: actor,
        reason: `Traveler requested specialist follow-up; callback preference: ${body.callback_preference}.`,
        unknowns,
      });
      return {
        handoff_id: handoff.packet.packet_id,
        status: "fixture_packet_ready_not_sent",
        callback_preference: body.callback_preference,
        duplicate: handoff.duplicate,
        live_handoff: false,
        provenance: "fixture",
      };
    },
  );

  app.post<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/retention-extension",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const body = parseBody(retentionBody, request.body);
      return runtime.deletion.extendRetention({
        tripId,
        actorTravelerId: travelerId(request),
        expectedContractVersion: body.expected_contract_version,
        retainUntil: body.retain_until,
      });
    },
  );

  app.delete<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId",
    async (request) => {
      const { tripId } = requirePath(versionedTripParams, request.params);
      const body = parseBody(deletionBody, request.body);
      return runtime.deletion.requestDeletion({
        tripId,
        actorTravelerId: travelerId(request),
        expectedContractVersion: body.expected_contract_version,
        confirmationPhrase: body.confirmation_phrase,
      });
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/api/v1/tasks/:taskId",
    async (request) => {
      const { taskId } = requirePath(taskParams, request.params);
      const actor = travelerId(request);
      const task = runtime.deletion.getTask(taskId);
      if (task.requested_by !== actor) throw httpError(404, "task_not_found");
      return { task, provenance: "fixture" };
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/v1/tasks/:taskId/run",
    async (request) => {
      const { taskId } = requirePath(taskParams, request.params);
      const actor = travelerId(request);
      const task = runtime.deletion.getTask(taskId);
      if (task.requested_by !== actor) throw httpError(404, "task_not_found");
      return runtime.deletion.runTask(taskId);
    },
  );

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      const authInfo = currentIdentity(request);
      (request.raw as typeof request.raw & { auth?: AuthInfo }).auth = authInfo;
      const server = createAccessHoldMcpServer(
        runtime,
        defaultMcpIdentityResolver,
      );
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        keepAliveMs: 0,
      });
      await server.connect(transport);
      reply.hijack();
      try {
        await transport.handleRequest(
          request.raw,
          reply.raw,
          request.method === "POST" ? request.body : undefined,
        );
      } finally {
        await server.close().catch(() => undefined);
      }
    },
  });

  return app;
}

async function main(): Promise<void> {
  const runtime = await createFixtureRuntime();
  process.env.ACCESSHOLD_FIXTURE_TRAVELER_ID = runtime.actorTravelerId;
  const app = await buildApiServer(runtime);
  const port = Number.parseInt(process.env.PORT ?? "4100", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  console.info(
    `AccessHold fixture API listening on ${host}:${port}; no live services are enabled.`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
