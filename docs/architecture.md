# AccessHold architecture

## Implemented local slices

```text
traveler-authorized confirmation email
                 │
                 ▼
 raw MIME + S3/SQS/SNS ingress validation
                 │
                 ▼
 injected itinerary extractor + stored constraint profile
                 │
                 ▼
 schema-validated live contract draft ──► traveler review
                 │
                 └── no monitoring or provider action before approval

fixture dashboard / MCP ──► fixture API and deterministic workflows
```

- `packages/contracts/` owns the canonical schema and typed access contracts; contract tests prevent schema-copy drift.
- `packages/policy-engine/` is pure TypeScript. It normalizes supported units, rejects unknown or unregistered predicates, evaluates evidence provenance/freshness, and aggregates only hard constraints into contract status.
- `packages/domain/` controls constraint capture and recovery transitions. Provider execution cannot jump directly to completion; replacement confirmation and hard-constraint revalidation are explicit inputs.
- `services/importer/` contains the fixture-oriented manual contract lifecycle, the SES MIME/S3/SQS/SNS parsing and authorization boundary, a separate live email-to-draft pipeline, and PostgreSQL/DynamoDB repository adapters. Email text does not create or alter accessibility constraints; imported constraints come from the traveler profile and start unverified.
- `services/monitor/`, `services/recovery/`, and `services/workflow/` provide deterministic fixture flows and do not call real travel providers, calendars, or human-handoff channels.
- `services/api/`, `services/mcp/`, and `apps/web/` provide the fixture-backed REST/MCP interface and responsive dashboard. The dashboard and Fastify smoke test use the `/api/v1` contract.
- `infra/` declares the AWS resource graph and has local CDK assertions/synthesis tests; synthesis is not deployment evidence.

## Runtime separation and limits

The local API deliberately composes fixture services and fixture authentication. It does not select the durable repository factory or enable Cognito authorization. The SES parser/handler and draft pipeline are adapter-ready libraries, but no production SQS worker, authorized-recipient provider, real itinerary extractor, or traveler-profile provider is wired. Until that composition exists, no live email import occurs. Any newly built contract remains a draft; importing never starts monitoring, sends provider requests, books travel, or updates a calendar.

PostgreSQL and DynamoDB adapters have fake-client tests; the optional PostgreSQL integration test requires an explicitly configured disposable database. No live database, migration, AWS client, SES delivery, queue worker, or deployment has been exercised. See [`email-ingress.md`](./email-ingress.md), [`persistence.md`](./persistence.md), [`infrastructure.md`](./infrastructure.md), and [`validation.md`](./validation.md).

AccessHold has no production dependency on another project and no shared database. Its output describes workflow evidence only; it is not a guarantee of physical accessibility.
