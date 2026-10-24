# AccessHold validation record

Recorded 2026-10-24. Evidence is limited to local source behavior, synthetic fixtures, CDK synthesis, and an HTTP smoke check. No AWS resources or live provider actions were created.

## Passing checks

| Check | Result |
| --- | --- |
| ESLint + Prettier | Passed, including `infra/` and `apps/web/` |
| TypeScript checks | Passed for the root services, React/Vite dashboard, and CDK project |
| Unit tests | 71/71 passed |
| Contract tests | 21/21 passed, including all eight MCP input/output schema pairs |
| Policy/security tests | 2/2 passed |
| Dashboard-to-Fastify smoke | 1/1 passed against the preserved `/api/v1` contract |
| Optional PostgreSQL integration | 1 skipped; `ACCESSHOLD_TEST_DATABASE_URL` was unset |
| CDK assertions | 8/8 passed |
| `cdk synth` | Passed; synthesis only, not deployment |
| npm audit, moderate and above | No known vulnerabilities |
| TypeScript build | Passed |
| React/Vite production build | Passed |
| **Total executed tests** | **103/103 passed; 1 optional PostgreSQL test skipped** |

`make test-infra` runs the isolated CDK typecheck, eight stack assertions, and local synthesis. Assertions cover required environment parameters, private/logged buckets, CloudFront OAC and TLS/API behaviors, Cognito OAuth client settings, recoverable encrypted DynamoDB/Aurora storage, SES receipt configuration, and ALB TLS. Synthesis emits only the informational CDK notice that 81 feature flags have not been configured; no resource was deployed.

SES tests cover raw MIME sanitization, direct S3 events, SQS batches carrying S3 or SNS notifications, authorization, manual-review routing, and draft-only import. The confirmation pipeline tests schema validation, traveler-profile constraints, unverified evidence, and duplicate delivery after a contract's status changes. Fake-client repository tests cover PostgreSQL history/optimistic append/deletion and DynamoDB history/traveler listing/tombstone deletion; the optional PostgreSQL integration test was skipped.

The earlier HTTP smoke check served the Vite dashboard document and fetched the fixture trip list, trip detail, and evidence through the Vite `/api` proxy using the `/api/v1` API routes (HTTP 200). This confirms local routing and fixture responses, not a full browser, visual, keyboard, or assistive-technology test. No headless browser binary was available in the environment.

The manual contract fixture validates schema, semantics, registered predicates, traveler scope, and fixture provenance. Tests cover draft correction, optimistic versions, stale approval rejection, known-violation rejection, append-only history, cross-traveler denial, live-document rejection, and reopening through a new file-repository instance. Constraint capture covers traveler wording, hard/preference priority, asset scope, and deterministic predicates; new constraints start unverified without fabricated evidence.

Provider verification questions are redacted, version-bound, hash-bound drafts. Tests require an exact owner approval and unchanged contract before send; ambiguous SES outcomes are not retried automatically. The SES adapter test uses a fake client. The running API composes the fixture adapter, so no actual email was sent.

The MCP/API tests exercise eight traveler-scoped tools, HTML resource templates, stateless Streamable HTTP transport, fixture authentication, evidence redaction, cross-traveler denial, and explicit fixture-only approval/receipt responses. The UI provides contract review, disruption, recovery approval, and privacy/deletion views. This is not evidence of a real Alexa+ session or production authorization.

Trip lifecycle tests cover contract export, correction, monitoring revocation, deletion confirmation, optimistic versions, and paginated S3 object-version/delete-marker cleanup. The S3 deletion adapter was tested against fakes only. Current deletion tasks and retention state are in memory, and the deployed workflow does not yet cover viewer tokens or cached prompts; no live deletion was performed.

The ReferenceTravel fixture pages exercise safe change, hard-constraint violation, recovery, immutable asset/evidence versions, and deterministic re-evaluation. The recovery fixture binds plans to contract/evidence versions, action list, cost, terms, inventory token, and expiry; it rejects stale plans and cross-plan approvals and records only a synthetic `TEST PROVIDER` receipt. The workflow fixture builds a traveler-scoped handoff without sending it and creates calendar intent only after confirmed recovery. It does not place a booking or update an external calendar.

## Reproduce

```bash
make lint typecheck
make test-unit test-contract test-integration test-e2e test-security test-infra
make build build-web
```

For a local dashboard smoke path, run `make dev-api` and `make dev-web` in separate shells. These use the local fixture runtime and do not start external services.

## Not evidenced

No real Alexa+ integration/device, live Cognito sign-in or JWT validation, SES inbound/outbound delivery, Bedrock, travel provider, external calendar, human-handoff channel, production database/migrations, durable queue worker, production idempotency, production deletion, accessibility-participant testing, performance/load test, AWS deployment, rollback/restore, or release evidence was executed. The hotel-room fixture does not satisfy the aircraft/dependent-transfer scenario. The CDK scaffold still requires the prerequisites and work listed in [`infrastructure.md`](./infrastructure.md); fixture success and successful synthesis do not satisfy those release gates.

No TypeScript coverage percentage is claimed. This record does not satisfy the specification's build-complete gate or guarantee physical accessibility.

## Sandbox, Pages, and Compose follow-up — 2026-10-24

| Check | Result |
| --- | --- |
| `corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test:unit && corepack pnpm test:e2e` | Passed; typecheck/lint clean, 79/79 unit tests across 17 files, and 4/4 E2E tests |
| `cd apps/web && corepack pnpm build` | Passed; dashboard production build completed |
| `VITE_SANDBOX=true corepack pnpm build:web` | Passed; `/accesshold/` static build includes the separate in-memory `sandbox-api` chunk |
| Local Vite route smoke | Passed; `/accesshold/` and `/accesshold/src/main.tsx` returned HTTP 200 |
| `corepack pnpm test:compose` | Blocked before launch: Docker CLI is absent, so no Compose stack started |
| `corepack pnpm record:demo` | Initially blocked by the missing Chromium browser; resolved for this run using temporary Chromium and FFmpeg packages outside the repository. Generated `docs/media/accesshold-demo.webm` and synchronized English caption/chapter VTTs |

The Compose launch check and CI workflow are implemented, but no container health or migration run is claimed. The initial no-Chromium recording failure was resolved for this run with temporary npm browser/FFmpeg tooling stored outside the repository; the recorder produced the WebM and matching VTT tracks from the fixture flow. GitHub Pages deployment was not run from this workspace. These demos stay fixture-only and do not change the live-integration and release-gate status above.

## Accessibility and demo-seed follow-up — 2026-10-24

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed for root, web, and infrastructure TypeScript projects |
| `pnpm lint` | Passed; ESLint and Prettier reported zero warnings/errors |
| `pnpm test:unit` | 75/75 passed across 15 files, including seed validation/idempotency and contrast calculations |
| `pnpm test:e2e` | 4/4 passed; `/api/v1` recovery flow, skip-link/landmarks, high-contrast persistence/focus trap, and provider-question announcements |
| `pnpm build:web` | Passed; Vite production bundle generated |
| Seed CLI dry run | Passed; schema/registry validation and scenario-only output verified for one simulated flight delay and one gate change |

The specified combined command `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:e2e` completed successfully. The contrast test verifies selected text/background component pairs against WCAG 2.1 AA thresholds (4.5:1 for normal-size text); the black/white High Contrast Mode pair is 21:1. E2E exercises keyboard behavior in jsdom, not a real browser or screen reader. No PostgreSQL or DynamoDB seed write was performed because no disposable/live database was configured. Real assistive-technology, 200% zoom, user-participant, and live-database checks remain outstanding.

## Video walkthrough follow-up — 2026-10-24

| Check | Result |
| --- | --- |
| `corepack pnpm --filter @accesshold/web build` | Passed; the dashboard built and copied the walkthrough assets under `dist/web/media/` |
| `VITE_SANDBOX=true corepack pnpm build:web` | Passed; static sandbox build contains the in-memory API adapter and video/caption/chapter assets |
| Built media artifacts | Verified WebM, English captions VTT, and chapters VTT exist under `dist/web/media/`; other `docs/` files are not copied into the site root |
| `corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test:unit && corepack pnpm test:e2e` | Passed; ESLint/Prettier clean, 79/79 unit tests across 17 files, and 5/5 E2E tests |
| Real-browser walkthrough smoke | Passed with temporary Playwright Chromium; the `/accesshold/media/` WebM loaded (13.64 seconds), both text tracks loaded (5 caption cues and 3 chapter cues), and the recovery chapter button sought to the VTT cue time |

The recorder writes `docs/media/accesshold-demo.webm` plus synchronized English captions and chapter tracks. The WebM is a silent, synthetic UI recording; its descriptive captions and transcript provide a text alternative for the visuals, and the player retains native controls. Temporary recording browser/FFmpeg tooling was kept outside the repository. Browser smoke checks are not a substitute for manual screen-reader, caption-quality, or user-participant validation.
