# AccessHold dependencies

## Locked local toolchain

- Node.js 22.x and Corepack; pnpm 10.17.1 is declared in `packageManager`.
- TypeScript 5.9.3, ESLint 10.13.0, Prettier 3.6.2, and Vitest 5.0.5.
- Ajv 8.20.0 and ajv-formats 3.0.1 for canonical contract validation.
- `tsx` 4.20.6 for the fixture entry point.
- `kotlin-compiler`, Android, AWS, provider, and application runtime dependencies are not installed.

All current dependencies are development dependencies; the deterministic source has no production package dependency. `pnpm-lock.yaml` controls the resolved graph. Only the explicitly listed `esbuild` install scripts are allowed by the pnpm configuration.

## Security audit

On 2026-10-23, the initial audit identified Vitest/Tinypool advisories and an Ajv advisory. Vitest was updated from 3.2.4 to 5.0.5 and Ajv from 8.17.1 to 8.20.0; lockfiles and tests were regenerated/rerun. The final command reported no known vulnerabilities:

```bash
corepack pnpm audit --audit-level=moderate
```

This is point-in-time advisory evidence, not a license review, malware-proof supply-chain guarantee, or production security assessment. Re-run on every dependency change and before release.

## External dependencies still blocked

Alexa+/MCP, SES, Bedrock, calendar, travel providers, deployed AWS resources, credentials, and participant/device access are not encapsulated in fake adapters. Their interfaces and real version/access verification remain future work. `make deploy` and native/integration/E2E targets remain intentionally blocked.
