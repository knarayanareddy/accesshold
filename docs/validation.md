# AccessHold validation record

Recorded 2026-10-24. Evidence is limited to local source behavior, synthetic fixtures, CDK synthesis, and an HTTP smoke check. No AWS resources or live provider actions were created.

## Passing checks

| Check | Result |
| --- | --- |
| ESLint + Prettier | Passed, including `infra/` and `apps/web/` |
| TypeScript checks | Passed for the root services, React/Vite dashboard, and CDK project |
| Unit tests | 59/59 passed |
| Contract tests | 21/21 passed, including all eight MCP input/output schema pairs |
| Policy/security tests | 2/2 passed |
| CDK assertions | 8/8 passed |
| `cdk synth` | Passed; synthesis only, not deployment |
| npm audit, moderate and above | No known vulnerabilities |
| TypeScript build | Passed |
| React/Vite production build | Passed |
| **Total tests** | **90/90 passed** |

`make test-infra` runs the isolated CDK typecheck, eight stack assertions, and local synthesis. Assertions cover required environment parameters, private/logged buckets, CloudFront OAC and TLS/API behaviors, Cognito OAuth client settings, recoverable encrypted DynamoDB/Aurora storage, SES receipt configuration, and ALB TLS. Synthesis emits only the informational CDK notice that 81 feature flags have not been configured; no resource was deployed.

The HTTP smoke check served the Vite dashboard document and successfully fetched the fixture trip list, trip detail, and evidence through the Vite `/api` proxy (HTTP 200). This confirms local routing and fixture responses, not a full browser, visual, keyboard, or assistive-technology test. No headless browser binary was available in the environment.

The manual contract fixture validates schema, semantics, registered predicates, traveler scope, and fixture provenance. Tests cover draft correction, optimistic versions, stale approval rejection, known-violation rejection, append-only history, cross-traveler denial, live-document rejection, and reopening through a new file-repository instance. Constraint capture covers traveler wording, hard/preference priority, asset scope, and deterministic predicates; new constraints start unverified without fabricated evidence.

Provider verification questions are redacted, version-bound, hash-bound drafts. Tests require an exact owner approval and unchanged contract before send; ambiguous SES outcomes are not retried automatically. The SES adapter test uses a fake client. The running API composes the fixture adapter, so no actual email was sent.

The MCP/API tests exercise eight traveler-scoped tools, HTML resource templates, stateless Streamable HTTP transport, fixture authentication, evidence redaction, cross-traveler denial, and explicit fixture-only approval/receipt responses. The UI provides contract review, disruption, recovery approval, and privacy/deletion views. This is not evidence of a real Alexa+ session or production authorization.

Trip lifecycle tests cover contract export, correction, monitoring revocation, deletion confirmation, optimistic versions, and paginated S3 object-version/delete-marker cleanup. The S3 deletion adapter was tested against fakes only. Current deletion tasks and retention state are in memory, and the deployed workflow does not yet cover viewer tokens or cached prompts; no live deletion was performed.

The ReferenceTravel fixture pages exercise safe change, hard-constraint violation, recovery, immutable asset/evidence versions, and deterministic re-evaluation. The recovery fixture binds plans to contract/evidence versions, action list, cost, terms, inventory token, and expiry; it rejects stale plans and cross-plan approvals and records only a synthetic `TEST PROVIDER` receipt. The workflow fixture builds a traveler-scoped handoff without sending it and creates calendar intent only after confirmed recovery. It does not place a booking or update an external calendar.

## Reproduce

```bash
make lint typecheck
make test-unit test-contract test-security test-infra
make build build-web
```

For a local dashboard smoke path, run `make dev-api` and `make dev-web` in separate shells. These use the local fixture runtime and do not start external services.

## Not evidenced

No real Alexa+ integration/device, live Cognito sign-in or JWT validation, SES inbound/outbound delivery, Bedrock, travel provider, external calendar, human-handoff channel, production database/migrations, durable queue worker, production idempotency, production deletion, accessibility-participant testing, performance/load test, AWS deployment, rollback/restore, or release evidence was executed. The hotel-room fixture does not satisfy the aircraft/dependent-transfer scenario. The CDK scaffold still requires the prerequisites and work listed in [`infrastructure.md`](./infrastructure.md); fixture success and successful synthesis do not satisfy those release gates.

No TypeScript coverage percentage is claimed. This record does not satisfy the specification's build-complete gate or guarantee physical accessibility.
