# AccessHold review

## 1. Scope and verdict

**Repository:** `knarayanareddy/accesshold`  
**Pinned SHA:** `f9d3d36715a507e10bd96c79017e62dec1a1f7dd`  
**Stage:** implementation slice, but fixture-first and not release-ready  
**Confidence:** medium on the active web/API/auth/storage boundary; low on unrun AWS, SES, DynamoDB, provider, and release paths.

**Verdict:** AccessHold is a real implementation slice, but the sampled path is still a local fixture system. The main blocker is that the runtime remains fixture-authenticated and fixture-backed.

**Runtime:** NOT RUN.

**Inspected sources**
- Local numbered evidence actually read in this pass: `fleet-hardening-review/evidence/accesshold/numbered-sources/README.md.txt:1-74`, `fleet-hardening-review/evidence/accesshold/numbered-sources/package.json.txt:1-75`, `fleet-hardening-review/evidence/accesshold/numbered-sources/Dockerfile.txt:1-19`, `fleet-hardening-review/evidence/accesshold/numbered-sources/docker-compose.yml.txt:1-99`, `fleet-hardening-review/evidence/accesshold/numbered-sources/apps/web/package.json.txt:1-10`, `fleet-hardening-review/evidence/accesshold/numbered-sources/apps/web/src/main.tsx.txt:1-8`, `fleet-hardening-review/evidence/accesshold/numbered-sources/apps/web/src/App.tsx.txt:1-220`, `fleet-hardening-review/evidence/accesshold/numbered-sources/packages/contracts/src/index.ts.txt:1-204`, `fleet-hardening-review/evidence/accesshold/numbered-sources/packages/domain/src/index.ts.txt:1-220`, `fleet-hardening-review/evidence/accesshold/numbered-sources/tests/unit/api-server.test.ts.txt:1-108`.
- Supplemental pinned ranges actually relied on: `services/api/src/server.ts:137-157,187-196`, `services/api/src/fixture-runtime.ts:43-52,59-85`, `services/importer/src/postgres-contract-repository.ts:61-85,114-170`, `services/importer/src/manual-contract-service.ts:105-110,204-205,227-231`.

**Uninspected or lightly inspected boundaries**
- SES adapter internals, MCP tool definitions, recovery/workflow service internals, DynamoDB repository internals, CDK stack implementation details, CSS/accessibility styling, and all runtime behavior.

See the staged fix plan in [REMEDIATION_PLAN.md](./REMEDIATION_PLAN.md).

## 2. Architecture and product boundary

The visible product boundary is a React/Vite dashboard bootstrapped from `apps/web/src/main.tsx`, which renders a single `App` root (`apps/web/src/main.tsx:1-8`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/apps/web/src/main.tsx#L1-L8). The web app imports accessibility-preference helpers and uses alert/status UI patterns (`apps/web/src/App.tsx:13-18,130-151,193-197`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/apps/web/src/App.tsx#L13-L18, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/apps/web/src/App.tsx#L130-L151, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/apps/web/src/App.tsx#L193-L197).

The backend entry point is `services/api/src/server.ts`, exposed by `dev:api` (`package.json:10-29`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/package.json#L10-L29). It serves REST and Streamable HTTP MCP. Contract types live in `packages/contracts`; domain rules keep traveler wording explicit and recovery transitions deterministic (`packages/contracts/src/index.ts:74-111`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/packages/contracts/src/index.ts#L74-L111; `packages/domain/src/index.ts:8-17,150-176,179-216`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/packages/domain/src/index.ts#L8-L17, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/packages/domain/src/index.ts#L150-L176, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/packages/domain/src/index.ts#L179-L216).

Storage is split. A durable Postgres repository exists with append-only version rows and locking (`services/importer/src/postgres-contract-repository.ts:61-85,114-170`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/importer/src/postgres-contract-repository.ts#L61-L85, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/importer/src/postgres-contract-repository.ts#L114-L170). But the sampled active runtime comes from `createFixtureRuntime()`, which seeds one checked-in contract into `InMemoryContractRepository` (`services/api/src/fixture-runtime.ts:43-52,59-85`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/api/src/fixture-runtime.ts#L43-L52, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/api/src/fixture-runtime.ts#L59-L85).

The repo also includes Docker Compose, a Dockerfile, Pages, and CDK-related scripts. The README is explicit that the stack is fixture-backed and “not deployed or production-ready,” and that the Pages build “does not call a live backend” (`README.md:4,32-46,70-72`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/README.md#L4-L4, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/README.md#L32-L46, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/README.md#L70-L72).

## 3. Findings ledger

### AH-SEC-01 — Medium — confirmed static
**Shared fixture bearer token is the active auth boundary for both REST and MCP, with a code-level default fallback.**

Evidence:
- `services/api/src/server.ts:137-157` — “`if (process.env.NODE_ENV === "production")`” and “`scopes: ["accesshold:read", "accesshold:write"],`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/api/src/server.ts#L137-L157
- `services/api/src/server.ts:187-196` — “`request.headers.authorization,`” and “`process.env.ACCESSHOLD_FIXTURE_TOKEN ?? "accesshold-local-demo-token",`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/api/src/server.ts#L187-L196
- `docker-compose.yml:50-54` — “`ACCESSHOLD_FIXTURE_TOKEN: accesshold-local-demo-token`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/docker-compose.yml#L50-L54
- `tests/unit/api-server.test.ts:23-40` — “`requires the local bearer token and returns owner-scoped trip state`” and “`process.env.ACCESSHOLD_FIXTURE_TOKEN = token;`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/tests/unit/api-server.test.ts#L23-L40

Impact: accidental non-production exposure grants broad fixture read/write and MCP access behind a shared secret. In production mode the same code returns 503 because no real identity provider is configured.

Recommended correction: separate fixture auth from live auth, remove the default token fallback, and make environment selection explicit and fail-closed.

### AH-OPS-02 — Medium — confirmed static
**The active API runtime is still in-memory even though durable storage adapters and local databases exist.**

Evidence:
- `services/api/src/fixture-runtime.ts:50-52` — “`const repository = new InMemoryContractRepository();`” and “`await repository.append(fixtureExample, null);`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/api/src/fixture-runtime.ts#L50-L52
- `README.md:32` — “`The running API and dashboard remain fixture-backed`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/README.md#L32-L32
- `README.md:46` — “`Fixture state is generally in memory and does not establish production durability.`”  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/README.md#L46-L46
- `services/importer/src/postgres-contract-repository.ts:61-85` — “`/** Aurora/PostgreSQL append-only contract-version storage. */`” and “`CREATE TABLE IF NOT EXISTS ${tableName}`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/importer/src/postgres-contract-repository.ts#L61-L85

Impact: restart-safe version history, deletion tasks, and recovery audit trail are not evidenced on the main app path.

Recommended correction: add an explicit runtime factory that selects fixture vs durable repositories, then verify restart persistence on the same server entry point that serves users.

### AH-ARC-03 — Medium — confirmed static
**The manual contract service deliberately rejects non-fixture provenance, so the current implementation cannot graduate to live ingestion without a new service boundary.**

Evidence:
- `services/importer/src/manual-contract-service.ts:105-110` — “`if (document.provenance !== "fixture")`” and “`issues.push("local_service_requires_fixture_provenance");`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/importer/src/manual-contract-service.ts#L105-L110
- `services/importer/src/manual-contract-service.ts:204-205` — “`if (corrected.provenance !== "fixture")`” and “`throw new Error("local_service_requires_fixture_provenance");`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/importer/src/manual-contract-service.ts#L204-L205
- `services/importer/src/manual-contract-service.ts:227-231` — “`allowFixture: true,`”.  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/services/importer/src/manual-contract-service.ts#L227-L231
- `README.md:70-72` — “`no real Alexa+ session`” and “`Fixture success does not satisfy live integration or release gates.`”  
  https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/README.md#L70-L72

Impact: the type model distinguishes `"live" | "fixture"`, but the sampled service layer is hard-pinned to fixture provenance. That is a release blocker.

Recommended correction: keep the fixture slice, but create a distinct live ingestion/service composition with provenance-specific validation, credentials, and outbound action controls.

## 4. Five-discipline assessment

- **Correctness / code review — applicable.** Typed contracts, semantic validation, traveler-constraint capture, and append-only versioning are present.
- **Automation / testing — applicable.** The manifest includes unit, contract, integration, e2e, security, infra, and Compose scripts (`package.json:10-29`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/package.json#L10-L29). Historical evidence recorded successful Compose and Pages runs at the pinned SHA.
- **DevOps / operations — applicable.** Dockerfile, Compose, Pages, and CDK exist (`Dockerfile:12-19`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/Dockerfile#L12-L19; `docker-compose.yml:45-95`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/docker-compose.yml#L45-L95).
- **OWASP / security — applicable.** Auth, authorization scope, provenance, deletion, and action approval are core concerns; the confirmed issue is the shared fixture token.
- **UI / UX / accessibility — applicable.** The dashboard models accessibility preferences and alerts (`apps/web/src/App.tsx:13-18,193-197`, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/apps/web/src/App.tsx#L13-L18, https://github.com/knarayanareddy/accesshold/blob/f9d3d36715a507e10bd96c79017e62dec1a1f7dd/apps/web/src/App.tsx#L193-L197). No confirmed accessibility defect is asserted.

## 5. Production blockers and owner questions

**Current blockers**
- Identity provider and traveler/session model are not implemented on the active path.
- Durable repository selection is not wired into the active API composition.
- Outbound provider, calendar, and handoff channels remain fixture/synthetic.
- Release target, secrets, and restore procedure are not evidenced.

**Owner questions**
1. Is the intended durable store Postgres only, or dual Postgres/DynamoDB?
2. What identity boundary is approved for traveler auth and MCP caller identity?
3. Which actions may ever become live: provider email, calendar mutation, rebooking, handoff?
4. What evidence-retention and deletion-restore policy is required?

## 6. Evidence inventory and limitations

**Inventory used**
- Local numbered files inspected: `fleet-hardening-review/evidence/accesshold/numbered-sources/README.md.txt:1-74`, `fleet-hardening-review/evidence/accesshold/numbered-sources/package.json.txt:1-75`, `fleet-hardening-review/evidence/accesshold/numbered-sources/Dockerfile.txt:1-19`, `fleet-hardening-review/evidence/accesshold/numbered-sources/docker-compose.yml.txt:1-99`, `fleet-hardening-review/evidence/accesshold/numbered-sources/apps/web/package.json.txt:1-10`, `fleet-hardening-review/evidence/accesshold/numbered-sources/apps/web/src/main.tsx.txt:1-8`, `fleet-hardening-review/evidence/accesshold/numbered-sources/apps/web/src/App.tsx.txt:1-220`, `fleet-hardening-review/evidence/accesshold/numbered-sources/packages/contracts/src/index.ts.txt:1-204`, `fleet-hardening-review/evidence/accesshold/numbered-sources/packages/domain/src/index.ts.txt:1-220`, `fleet-hardening-review/evidence/accesshold/numbered-sources/tests/unit/api-server.test.ts.txt:1-108`.
- Supplemental pinned source ranges relied on: `services/api/src/server.ts:137-157,187-196`, `services/api/src/fixture-runtime.ts:43-52,59-85`, `services/importer/src/postgres-contract-repository.ts:61-85,114-170`, `services/importer/src/manual-contract-service.ts:105-110,204-205,227-231`.

**Exact checks not run**
- README commands not run from `fleet-hardening-review/evidence/accesshold/numbered-sources/README.md.txt:13-44`: `make setup`, `make dev`, `make dev-api`, `make dev-web`, `make lint`, `make typecheck`, `make test-unit`, `make test-contract`, `make test-integration`, `make test-e2e`, `make test-infra`, `make test-security`, `make build`, `make build-web`, `docker compose up --build`, `corepack pnpm test:compose`, `VITE_SANDBOX=true corepack pnpm build:web`, `corepack pnpm --filter @accesshold/web build`, `corepack pnpm record:demo`, `corepack pnpm exec playwright install chromium`, and `pnpm seed:traveler-data ...`.
- Manifest scripts not run from `fleet-hardening-review/evidence/accesshold/numbered-sources/package.json.txt:10-29`: `dev`, `dev:api`, `dev:web`, `build`, `build:web`, `lint`, `typecheck`, `test:unit`, `test:contract`, `test:integration`, `test:e2e`, `migrate:postgres`, `seed:traveler-data`, `record:demo`, `test:compose`, `test:security`, `typecheck:infra`, `test:infra`, and `synth:infra`.
- Historical GitHub Actions runs were observed in snapshot metadata but not rerun locally.

These checks were left unrun because this pass was limited to documentation authorship and the task forbade execution, installs, live services, credentials, and fixes. I can confirm static boundaries and stage limitations, but not live behavior, deployment correctness, restore viability, or environment security posture.
