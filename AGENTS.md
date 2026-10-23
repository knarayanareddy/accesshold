# AccessHold Agent Instructions

You are the implementation agent for **AccessHold only**. Your project root is `projects/accesshold/`.

## Assignment

Build post-booking accessibility evidence monitoring and explicitly approved disruption recovery. The primary hackathon track is **Alexa+**.

Current state: canonical specification, schemas/examples, low-fidelity UI contracts, and an initial locally validated domain/content foundation exist. Applications, live integrations, device evidence, user evidence, and most release gates remain incomplete; see `docs/validation.md`.

## Read these files first

1. [`SPEC.md`](./SPEC.md) — normative project requirements and implementation slices.
2. [`./specs/SHARED_ENGINEERING_STANDARD.md`](./specs/SHARED_ENGINEERING_STANDARD.md) — shared release-blocking engineering requirements.
3. [`ui/PRODUCT.md`](./ui/PRODUCT.md), [`ui/DESIGN.md`](./ui/DESIGN.md), and [`ui/WIREFRAMES.md`](./ui/WIREFRAMES.md) — product truth and design behavior.
4. [`schemas/access-contract.schema.json`](./schemas/access-contract.schema.json) and [`examples/access-contract.example.json`](./examples/access-contract.example.json) — canonical contract and explicitly fictional fixture/draft example.
5. [`SPEC_TRACEABILITY.md`](./SPEC_TRACEABILITY.md) and [`SPEC_DEVIATIONS.md`](./SPEC_DEVIATIONS.md) — registers you must maintain.

The research reports at the repository root are context, not authority. Normative precedence is current law/platform/hackathon rules → `SPEC.md` → shared engineering standard → UI/product guidance → research → convenience.

## Ownership and non-negotiable boundaries

- Create implementation code, tests, docs, and evidence only inside `projects/accesshold/`. Do not modify a sibling project.
- Treat `SPEC.md`, canonical schemas/examples, and UI contracts as controlled inputs. Do not silently change them; record and escalate required changes in `SPEC_DEVIATIONS.md`.
- Shared files under `specs/` and repository indexes are read-only unless the user separately assigns a cross-project change.
- Do not import another project's production code, create a shared production runtime/database, or broaden scope to another hackathon track.
- Preserve every requirement and acceptance ID. Update `SPEC_TRACEABILITY.md` with actual paths and status after each vertical slice.
- Never fabricate credentials, provider responses, device runs, observations, approvals, accessibility results, user research, or outcome evidence.
- Fixtures and sandboxes must remain labeled and must never satisfy a live-integration release gate.
- Never commit secrets, raw private media, credentials, or sensitive evidence. Use `.env.example` with safe names/examples only.

## Project-specific safeguards

- Keep Access Contract evaluation deterministic. Models may extract or draft, but cannot mutate contract state or invoke provider actions.
- Require approval of the exact plan hash before an external action; provider acknowledgement is not recovery completion.
- Close recovery only after importing a replacement confirmation and revalidating every hard constraint.
- Never guarantee physical accessibility from documents, reviews, provider text, or model output.

## External preflight and blockers

Verify the actual current APIs, SDKs, platform rules, and access before relying on them. The following are execution dependencies, not things to simulate silently:

- Alexa+ Skill/MCP and required simulator or working simulated Alexa+ web experience
- AWS, SES, Bedrock, and any configured calendar credentials
- Travel-provider read/action capabilities and independently imported confirmations
- Accessibility and traveler-review participants for required evaluation

If a dependency is unavailable, implement only independently testable slices, label the corresponding release gate **blocked**, and continue with an honest fallback where the specification permits one.

## Execution sequence

1. Run preflight and record tool/API/model versions, available real integrations, and blockers in `docs/`.
2. Scaffold the repository layout required by `SPEC.md` and the shared standard, including canonical `make` commands, pinned lockfiles, `.gitignore`, and `.env.example`.
3. Add schema/domain contract tests before connecting adapters. Keep deterministic domain logic independent of cloud/model/device calls.
4. Implement the specification's vertical slices in order. Every slice includes tests, accessibility, security/privacy behavior, and traceability updates.
5. Implement the UI from `ui/tokens.json`, component contracts, and documented states. Static wireframes are guidance, not proof of platform behavior.
6. Keep production and fixture adapters behind the specified typed interfaces. Real required Amazon technology must execute in the main product path for release/demo evidence.
7. Generate only reproducible, non-sensitive evidence. Do not mark completion from unit tests or simulated sponsor integrations alone.

## Completion gate

Do not claim build-complete until every P0 scenario and release gate has evidence, all required real integrations/devices have run, security/privacy/accessibility requirements pass, a clean-checkout setup has been independently executed, and the specification rubric scores at least **90/100 with no category below 70%**. Record any unmet item as incomplete or blocked.
