# AccessHold preflight

Recorded 2026-10-23 for the initial local foundation. This is a point-in-time workstation record, not a clean-checkout or release certification.

## Available and exercised

| Capability | Recorded version/state |
| --- | --- |
| Node.js | 22.22.3; `package.json` requires Node 22.x |
| pnpm | 10.17.1 through Corepack and `packageManager` |
| TypeScript | 5.9.3, locked |
| Test runner | Vitest 5.0.5, locked |
| Schema validator | Ajv 8.20.0 with ajv-formats 3.0.1 |
| Repository | Independent `projects/accesshold/` workspace; no sibling runtime imports |

`make setup` is the reproducible local setup entry point. `.env.example` contains safe placeholders only. No credentials were requested or written.

## Blocked or not implemented

- Alexa+ Agent Skill/MCP backend, simulator, and rich-card authorization path.
- AWS credentials and deployed SES, Bedrock, calendar, storage, and workflow resources.
- Travel-provider read/action capabilities and independent replacement confirmations.
- Application UI/API, durable persistence, provider ingestion, and deletion workers.
- Accessibility/traveler participants, device runs, production deployment, and release evidence.

These dependencies must be genuinely available and exercised before their corresponding traceability rows can become release-verified. Fixtures are not substitutes.

## First local checks

```bash
node --version
corepack pnpm --version
make bootstrap
make lint typecheck test-unit test-contract test-security build
make dev
```

A dependency audit requires network access to the npm advisory service. Any audit failure must be fixed or explicitly recorded; it must not be hidden by lowering the severity threshold.
