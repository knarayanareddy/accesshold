# AccessHold

**Track:** Alexa+
**Status:** local fixture slices cover contract review, provider-question approval, recovery, the MCP/API path, and the React dashboard; the CDK stack typechecks and synthesizes, but the product is not deployed or production-ready.
**Agent entry point:** [`AGENTS.md`](./AGENTS.md)

AccessHold is post-booking accessibility evidence monitoring and explicitly approved disruption recovery. Its output describes workflow evidence, never a guarantee of physical accessibility.

## Local development

Requirements: Node.js 22, Corepack, and `make`. Dependencies are pinned by `package.json` and `pnpm-lock.yaml`.

```bash
make setup
make dev                   # offline fixture walking path
make dev-api               # fixture-backed Fastify REST + Streamable HTTP MCP
make dev-web               # React/Vite dashboard; API proxy targets dev-api
make lint typecheck
make test-unit test-contract test-infra
make build build-web
```

`make test-security` also audits the locked npm dependency graph. Infrastructure checks are local-only: `make test-infra` runs the CDK TypeScript check, CDK assertions, and `cdk synth`; it does not contact AWS. `make synth-infra` is available separately. `make test-integration`, `make test-e2e`, and `make deploy` remain blocked because real provider, identity, database, release, and Alexa+ validation are not implemented or authorized.

The fixture walking path imports and explicitly activates a synthetic manual contract, consumes two explicitly requested ReferenceTravel change pages, builds and approves a plan-bound recovery option, records one duplicate-safe `TEST PROVIDER` receipt, imports a synthetic replacement confirmation, creates a retry-safe handoff packet and confirmed-itinerary calendar intent, and reopens four versions through a new JSON repository instance. Provider-question drafts are hash-bound and sent only after explicit approval in the fixture service; all sample provider outcomes are clearly synthetic. Fixture state is generally in memory and does not establish production durability.

## Workspace map

| Path | Purpose |
| --- | --- |
| [`SPEC.md`](./SPEC.md) | Canonical implementation specification and vertical slices |
| [`schemas/`](./schemas/) | Canonical machine-readable contracts |
| [`examples/access-contract.example.json`](./examples/access-contract.example.json) | Fictional fixture, not real evidence |
| [`packages/contracts/`](./packages/contracts/) | Typed schemas and MCP tool contracts |
| [`packages/policy-engine/`](./packages/policy-engine/) | Deterministic units, predicates, evidence freshness, and aggregation |
| [`packages/domain/`](./packages/domain/) | Contract, provider-question, and recovery rules |
| [`services/importer/`](./services/importer/) | Fixture contract lifecycle, approved provider questions, and deletion adapters |
| [`services/monitor/`](./services/monitor/) | ReferenceTravel fixture changes, immutable versions, and recovery timelines |
| [`services/recovery/`](./services/recovery/) | Plan-bound fixture options, approvals, and synthetic receipts |
| [`services/mcp/`](./services/mcp/) | Traveler-scoped MCP tools and HTML resource templates |
| [`services/api/`](./services/api/) | Fixture-backed REST API and stateless Streamable HTTP MCP endpoint |
| [`apps/web/`](./apps/web/) | Responsive React/Vite contract, disruption, and recovery dashboard |
| [`infra/`](./infra/) | AWS CDK resource graph and synthesis assertions; deployment prerequisites remain |
| [`content/feature-registry/`](./content/feature-registry/) | Draft feature definitions; not provider verification |
| [`tests/`](./tests/) | Unit, canonical-contract, and policy-boundary tests |
| [`docs/`](./docs/) | Preflight, architecture, infrastructure limits, and validation record |
| [`ui/WIREFRAMES.md`](./ui/WIREFRAMES.md) | Authoritative UI contract |

## Not production evidence

The MCP/API and dashboard use deterministic fixture services and fixture authentication. No real Alexa+ session, SES delivery, Cognito sign-in, production database, queue worker, migration, external travel provider, calendar, or human-handoff channel has been exercised. The CDK stack has not been deployed; it requires environment inputs, images, DNS/certificates, verified SES identity, real authentication/persistence wiring, deployment tasks, and operational review. See [`docs/infrastructure.md`](./docs/infrastructure.md), [`docs/preflight.md`](./docs/preflight.md), and [`docs/validation.md`](./docs/validation.md). Fixture success does not satisfy live integration or release gates.

Maintain [`SPEC_TRACEABILITY.md`](./SPEC_TRACEABILITY.md) and [`SPEC_DEVIATIONS.md`](./SPEC_DEVIATIONS.md) as slices are completed. Do not import another project's production code or create a shared runtime/database.
