# AccessHold remediation plan

## 1. Phased roadmap with entry and exit criteria

| Phase | Entry criteria | Exit criteria |
| --- | --- | --- |
| 0. Baseline and boundary decisions | Current fixture slice exists | Signed decision naming live auth, durable store, and allowed live actions |
| 1. Confirmed defects on active path | Phase 0 complete | Fixture auth default removed; runtime selection explicit; server fails closed when live deps are absent |
| 2. Risk-based security and storage hardening | Phase 1 complete | Live auth boundary and durable repository path implemented behind explicit gating |
| 3. Meaningful automation | Phase 2 complete | Negative tests prove auth rejection, version conflicts, and restart persistence on the real selected runtime |
| 4. Deployment, rollback, and recovery | Phase 3 complete | Release playbook, migration ownership, rollback, and restore drill are documented and checked |
| 5. Independent acceptance | Phase 4 complete | Reviewer other than implementer verifies auth, storage, action boundary, and rollback evidence |

## 2. Task dependency map

| Task | Depends on | Why |
| --- | --- | --- |
| AH-T01 Architecture boundary ADR | — | Owner decisions unblock all implementation work |
| AH-T02 Live auth and MCP identity boundary | AH-T01 | Needs approved identity model |
| AH-T03 Durable runtime composition | AH-T01 | Needs approved persistence target |
| AH-T04 Outbound action and handoff hardening | AH-T01, AH-T02, AH-T03 | Must sit behind real auth and audit trail |
| AH-T05 Independent acceptance and release rehearsal | AH-T02, AH-T03, AH-T04 | Final release gate |

## 3. Task details

### AH-T01 — Architecture boundary ADR
- **Linked requirement:** preventive task for all three findings
- **Observed/proposed path:** observed repo root docs; proposed `docs/architecture.md` or ADR folder
- **Owner:** engineering + product/security
- **Prerequisites:** baseline captured; deployment target identified; data-retention owner named
- **Steps:**
  1. Record whether AccessHold will support live traveler access or remain fixture/demo only.
  2. Choose one authoritative auth model for REST and MCP callers.
  3. Choose one authoritative durable-store model and define whether DynamoDB stays, becomes secondary, or is removed from the active path.
  4. Enumerate which actions are forever fixture-only and which require live implementation later.
- **Expected output:** ADR with auth, storage, action, and release/rollback scope
- **Verification:** reviewer can map each chosen boundary to concrete code paths and envs
- **Definition of Done:**
  - [ ] Live vs fixture operating modes are explicitly named
  - [ ] Auth owner and storage owner are named
  - [ ] Outbound live actions are allowlisted
  - [ ] Rollback target state is defined
- **Release / rollback / recovery:** no release from this task; rollback is ADR revision
- **Independent acceptance:** reviewer confirms no later task depends on an unstated assumption

### AH-T02 — Replace fixture auth with a fail-closed live identity boundary
- **Linked finding:** AH-SEC-01
- **Observed/proposed path:** observed `services/api/src/server.ts`; proposed live identity module and fixture/live runtime split
- **Owner:** backend/security
- **Prerequisites:** ADR approved; token rotation method chosen; caller identity claims documented
- **Steps:**
  1. Move fixture bearer-token logic behind an explicit fixture-mode adapter.
  2. Add a live auth resolver for REST and MCP that rejects requests when identity config is absent.
  3. Remove the code-level default token fallback and require explicit fixture configuration for local mode.
  4. Ensure traveler identity comes from validated auth claims rather than environment fallback.
- **Expected output:** fixture auth is opt-in; live auth is separate and fail-closed
- **Verification:** missing live auth config fails; wrong token/claims fail; MCP and REST use the same identity source
- **Definition of Done:**
  - [ ] No shared default token remains in the active path
  - [ ] Fixture mode is explicit, not implicit
  - [ ] MCP identity and REST identity are aligned
  - [ ] Error responses avoid leaking secrets or internal tokens
- **Release / rollback / recovery:** release behind environment flag or separate entry point; rollback to fixture-only mode if live auth blocks release
- **Independent acceptance:** non-author reviewer proves bad tokens and absent config are rejected on both `/api/v1/*` and `/mcp`

### AH-T03 — Wire the durable repository into the active runtime
- **Linked finding:** AH-OPS-02
- **Observed/proposed path:** observed `services/api/src/fixture-runtime.ts` and `services/importer/src/postgres-contract-repository.ts`; proposed runtime factory under `services/api/src/`
- **Owner:** backend/platform
- **Prerequisites:** ADR approved; migration owner assigned; backup/restore target selected
- **Steps:**
  1. Introduce a runtime factory that selects fixture or durable repository composition.
  2. Connect the server entry point to that factory so the active API path can run against Postgres without code swapping.
  3. Keep append-only version semantics and optimistic locking across both fixture and durable modes.
  4. Define migration ownership as a deployment step.
- **Expected output:** one server entry point supporting explicit fixture and durable modes
- **Verification:** create data, restart the durable runtime, confirm the same trip/version history remains; negative test must fail on version conflict
- **Definition of Done:**
  - [ ] Active runtime can use durable storage without patching code
  - [ ] Restart persistence is demonstrated on the selected runtime
  - [ ] Version-conflict handling is preserved
  - [ ] Migration ownership is documented
- **Release / rollback / recovery:** release only after migration/backout steps exist; rollback can switch traffic to fixture/demo or prior schema-compatible build
- **Independent acceptance:** reviewer reproduces restart persistence and version-conflict rejection without relying on fixture-only paths

### AH-T04 — Harden outbound action, approval, and handoff boundaries
- **Linked finding:** AH-ARC-03
- **Observed/proposed path:** observed fixture-only behavior in `services/api/src/fixture-runtime.ts` and `services/importer/src/manual-contract-service.ts`; proposed live adapters under existing importer/recovery/workflow service trees
- **Owner:** backend/product/operations
- **Prerequisites:** live auth available; durable audit trail available; owner-approved allowlist of live actions exists
- **Steps:**
  1. Split fixture-only action adapters from future live adapters.
  2. Require explicit approval provenance and audit recording before any live action executes.
  3. Add idempotency and recovery handling for provider questions, bookings, calendar writes, and handoff.
  4. Preserve a no-live-action sandbox path for demo and Pages use.
- **Expected output:** explicit live/fixture action boundary with auditable approvals and rollback rules
- **Verification:** sandbox mode never sends live actions; live mode rejects unapproved or duplicate requests
- **Definition of Done:**
  - [ ] Live actions are allowlisted and auditable
  - [ ] Sandbox mode cannot drift into live behavior
  - [ ] Duplicate execution is rejected or safely deduplicated
  - [ ] Human-handoff recovery path is defined
- **Release / rollback / recovery:** staged rollout by action type; rollback disables live adapters while retaining read-only visibility
- **Independent acceptance:** reviewer validates one approved path and several forbidden paths, including duplicate and missing-approval cases

### AH-T05 — Independent acceptance, release, rollback, and restore rehearsal
- **Linked requirement:** final gate for AH-SEC-01, AH-OPS-02, AH-ARC-03
- **Observed/proposed path:** proposed release docs and acceptance records under `docs/` and workflow/playbook locations already used by the repo
- **Owner:** platform/security + independent reviewer
- **Prerequisites:** tasks T02-T04 complete; release environment exists; backup/restore mechanism exists
- **Steps:**
  1. Write a release checklist covering migrations, secrets, auth config, and action-mode flags.
  2. Write a rollback checklist that returns the service to the previous safe mode.
  3. Perform and record an independent restore rehearsal for contract-version data and queued action state.
  4. Record acceptance evidence separately from developer assertions.
- **Expected output:** release runbook, rollback runbook, and acceptance packet
- **Verification:** reviewer confirms bad auth is rejected, durable data survives restart, forbidden actions remain blocked, and rollback returns the system to a known-safe state
- **Definition of Done:**
  - [ ] Release checklist exists and is environment-specific
  - [ ] Rollback steps are ordered and testable
  - [ ] Restore evidence is recorded from an actual rehearsal
  - [ ] Acceptance is signed by someone other than the implementer
- **Release / rollback / recovery:** no release without completed rollback and restore evidence
- **Independent acceptance:** required; developer self-attestation is insufficient

## 4. Independent acceptance roles

All five disciplines must sign off independently on the release-candidate SHA named in AH-T05.

- **Correctness / code review reviewer:** confirms contract, domain, and repository changes preserve append-only versioning, provenance rules, and fixture-vs-live separation.
- **Automation / testing reviewer:** confirms negative auth, duplicate-action, optimistic-conflict, and restart-persistence checks fail when deliberately broken and pass only on the intended runtime.
- **DevOps / operations reviewer:** confirms the governing release artifact, migration order, rollback steps, restore rehearsal record, and post-rollback checks are complete and environment-specific.
- **OWASP / security reviewer:** confirms fixture token fallback is removed from live-capable paths, `/api/v1/*` and `/mcp` share one identity boundary, and live actions cannot execute without approved gating.
- **UI / UX / accessibility reviewer:** confirms sandbox/live labeling is clear, alert/approval flows remain understandable after auth/storage changes, and accessibility affordances are rechecked on the release-candidate UI.

## 5. Repo-level release / rollback / recovery policy

- **Governing release artifact:** a pinned candidate commit plus the AH-T05 release runbook, rollback runbook, and independent acceptance packet; GitHub Pages sandbox output and local fixture Compose runs are not live-release artifacts.
- **Release trigger:** AH-T02 through AH-T05 DoD complete, owner approvals complete, and all five independent discipline reviewers sign off on the same candidate SHA.
- **Rollback trigger:** auth regression, storage or migration mismatch, unexpected live-action reachability, failed post-deploy verification, or inability to prove restore state.
- **Safe fallback mode:** revert to the last known schema-compatible build; if live auth or live adapters are unsafe, fall back to clearly labeled fixture/demo-only operation rather than leaving a partially live action path exposed.
- **Post-rollback checks:** verify `/api/v1/*` and `/mcp` enforce the intended auth mode, bad credentials are rejected, live actions are disabled in fallback mode, expected contract data remains reachable for the selected storage mode, and the rollback/restore record is appended to the acceptance packet.

## 6. Changes requiring owner approval

- Identity provider choice and traveler-identity claims
- Whether DynamoDB remains in scope
- Any live provider email, calendar mutation, or rebooking
- Data retention, deletion workflow, and recovery retention after rollback
- Production hosting target and operational ownership

## 7. Production acceptance checklist

- [ ] Active runtime is no longer implicitly fixture-authenticated
- [ ] Durable storage is proven on the same server entry point users will hit
- [ ] Sandbox/demo mode cannot be mistaken for live mode
- [ ] Negative auth and duplicate-action tests fail when behavior is deliberately broken
- [ ] Migration, rollback, and restore procedures are written and checked
