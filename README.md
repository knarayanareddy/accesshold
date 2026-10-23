# AccessHold

**Track:** Alexa+
**Status:** manual contract, ReferenceTravel monitoring, fixture recovery, handoff, and confirmed-calendar-intent slices validated locally; application and live integrations not implemented
**Agent entry point:** [`AGENTS.md`](./AGENTS.md)

AccessHold is post-booking accessibility evidence monitoring and explicitly approved disruption recovery. Its output describes workflow evidence, never a guarantee of physical accessibility.

## Local foundation

Requirements: Node.js 22, Corepack, and `make`. Dependencies are pinned by `package.json` and `pnpm-lock.yaml`.

```bash
make setup                 # install and create .env.local from safe examples
make dev                   # run the explicitly labeled fixture walking path
make lint typecheck
make test-unit test-contract test-security
make build
```

`make test-security` also audits the locked npm dependency graph. `make test-integration`, `make test-e2e`, `make test-infra`, and `make deploy` intentionally fail while their real dependencies are absent.

The current fixture imports and explicitly activates a synthetic manual contract, consumes two explicitly requested ReferenceTravel change pages, builds and approves a plan-bound recovery option, records one duplicate-safe `TEST PROVIDER` outbox receipt, imports a synthetic replacement confirmation, creates a retry-safe human-handoff packet and confirmed-itinerary calendar intent, and reopens four versions through a new JSON repository instance. It exercises immutable asset/evidence versions and a violation-to-completed recovery timeline. Event dedupe, plans, receipts, handoffs, calendar intents, and case indexes are in-memory. It does not import email, start a monitoring worker, call Alexa+, SES, Bedrock, an external calendar, a human handoff channel, or a live travel provider, execute a replacement booking, or provide production durability.

## Workspace map

| Path | Purpose |
| --- | --- |
| [`SPEC.md`](./SPEC.md) | Canonical implementation specification and vertical slices |
| [`schemas/access-contract.schema.json`](./schemas/access-contract.schema.json) | Canonical machine-readable contract |
| [`examples/access-contract.example.json`](./examples/access-contract.example.json) | Validated fictional fixture, not real evidence |
| [`packages/contracts/`](./packages/contracts/) | Typed schema loading and byte-identical schema copy |
| [`packages/policy-engine/`](./packages/policy-engine/) | Deterministic units, predicates, evidence freshness, and aggregation |
| [`packages/domain/`](./packages/domain/) | Recovery-state and replacement-confirmation rules |
| [`services/importer/`](./services/importer/) | Traveler-scoped manual drafts, explicit activation, and fixture-only version repositories |
| [`services/monitor/`](./services/monitor/) | Deduplicated ReferenceTravel fixture changes, immutable versions, and recovery timelines; no worker |
| [`services/recovery/`](./services/recovery/) | Plan-bound fixture options, approvals, TEST PROVIDER outbox receipts, and confirmation replay; no live action |
| [`services/workflow/`](./services/workflow/) | Scoped human-handoff packets and confirmed-version fixture calendar intents; no external delivery |
| [`packages/adapters/reference-travel/`](./packages/adapters/reference-travel/) | Deterministic TEST PROVIDER change pages; no network or live capability |
| [`content/feature-registry/`](./content/feature-registry/) | Draft feature definitions; not provider verification |
| [`scripts/walking-skeleton.ts`](./scripts/walking-skeleton.ts) | Offline fixture path |
| [`tests/`](./tests/) | Unit, canonical-contract, and policy-boundary tests |
| [`docs/`](./docs/) | Preflight, architecture, data inventory, dependencies, and validation |
| [`ui/`](./ui/) | Static design guidance, not a production frontend |

## External blockers

Alexa+/MCP, AWS/SES/Bedrock, travel-provider capabilities, independently imported confirmations, accessibility participants, deployment, and release evidence remain unavailable or unimplemented. See [`docs/preflight.md`](./docs/preflight.md) and [`docs/validation.md`](./docs/validation.md). Fixture success cannot satisfy those gates.

Maintain [`SPEC_TRACEABILITY.md`](./SPEC_TRACEABILITY.md) and [`SPEC_DEVIATIONS.md`](./SPEC_DEVIATIONS.md) as slices are completed. Do not import another project's production code or create a shared runtime/database.
