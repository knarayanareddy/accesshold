# Local and standalone demo environments

These environments are deterministic demonstrations only. They use `TEST PROVIDER` fixtures and do not send provider requests, place bookings, or prove live integrations.

## Docker Compose

From the repository root, run:

```bash
docker compose up --build
```

| Service                                         | Host port | Health / startup behavior                                                                        |
| ----------------------------------------------- | --------: | ------------------------------------------------------------------------------------------------ |
| PostgreSQL 16                                   |      5432 | `pg_isready`; the API startup command applies `001_contract_versions.sql` before listening       |
| DynamoDB Local (`amazon/dynamodb-local:latest`) |      8000 | TCP listener healthcheck; disposable local emulator volume                                       |
| Fastify REST + Streamable HTTP MCP              |      3000 | `/health`; waits for PostgreSQL and DynamoDB Local, then serves the in-memory fixture runtime    |
| Vite coordinator dashboard                      |      5173 | `/accesshold/`; waits for a healthy API and proxies `/api` and `/mcp` to the Compose API service |

The PostgreSQL schema is prepared for local persistence work but the current Compose API remains fixture-backed and does not write contract records to PostgreSQL or DynamoDB. Stop the stack with `docker compose down`; named data volumes are retained. `corepack pnpm test:compose` performs one isolated `docker compose up --build --detach --wait`, verifies the API, dashboard, and migrated table, then removes only its isolated test volumes.

## GitHub Pages

`.github/workflows/pages.yml` builds `dist/web` with `VITE_SANDBOX=true` and deploys it to the repository's Pages site. The Vite base is `/accesshold/`; enable **GitHub Actions** as the Pages deployment source in repository settings. The static client adapter imports `createFixtureRuntime()` and uses its in-memory repositories and services with checked-in synthetic fixtures. It opens no network connection and resets in-memory state when the page reloads.

The standalone sandbox deliberately does not satisfy live Alexa+, provider, persistence, or release-evidence gates. `INT-AH-002` and the live demo requirements in `SPEC.md` remain unchanged.

## Video recorder

Start Docker Compose, install the Playwright Chromium binary once, then run:

```bash
corepack pnpm exec playwright install chromium
corepack pnpm record:demo
```

`record-demo.ts` records High Contrast Mode, the disruption review, option selection, explicit plan approval, and the fixture receipt that remains **awaiting provider confirmation**. It writes `docs/media/accesshold-demo.webm` with synchronized English captions and WebVTT chapter cues. The WebM and VTT files are public Pages assets served from `/accesshold/media/`; `.gitkeep` tracks the output directory. `DEMO_BASE_URL` can override the default local dashboard URL. The recording is synthetic demo media, not evidence of a live booking or confirmed accessibility.
