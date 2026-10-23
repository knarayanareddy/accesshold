# AccessHold foundation architecture

## Implemented boundaries

```text
fictional Access Contract + draft feature registry
                    │
                    ▼
       canonical JSON Schema validation
                    │
                    ▼
 deterministic predicate/evidence evaluator ──► workflow status + reason codes
                    │
                    ▼
      recovery transition/confirmation rules (fixture only)
```

- `packages/contracts/` owns typed contract access and a byte-identical copy of the canonical schema. Contract tests prevent drift.
- `packages/policy-engine/` is pure TypeScript. It normalizes supported units, rejects unknown/unregistered values, evaluates evidence provenance/freshness, and aggregates only hard constraints into contract status.
- `packages/domain/` controls recovery transitions. Provider execution cannot jump directly to completion; replacement confirmation and hard-constraint revalidation are explicit inputs.
- `scripts/walking-skeleton.ts` wires only labeled fixture data. Fixture evidence is rejected unless fixture evaluation is explicitly enabled.
- `content/feature-registry/` is draft content, not proof that a provider or physical feature was verified.

## Deliberately absent

There is no web/API application, database, queue, email parser, model gateway, provider adapter, calendar adapter, authentication, or deployment unit. Empty adapter/application directories reserve ownership boundaries only.

Future live adapters must translate provider data into typed drafts without gaining authority to mutate hard constraints or execute recovery. Exact-plan approval, idempotency, durable audit state, and replacement-confirmation ingestion remain release-blocking work.

## Independence and output limits

AccessHold has no production dependency on another project and no shared database. Its current output is workflow evidence state only; it does not assert physical accessibility, send messages, modify bookings, or update calendars.
