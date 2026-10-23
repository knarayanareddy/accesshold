# AccessHold data inventory

Inventory date: 2026-10-23. This describes the current local slices, not a production data-flow assessment.

| Data | Current location | Classification/provenance | Retention and use |
| --- | --- | --- | --- |
| Fictional Access Contract | `examples/access-contract.example.json` | Synthetic trip/accessibility/evidence fixture; not a traveler record | Source-controlled example; schema and deterministic tests only |
| Draft feature definitions | `content/feature-registry/v1.json` | Authored development content; unverified provider/physical claims | Source-controlled draft; predicate evaluation only |
| Canonical schema copies | `schemas/`, `packages/contracts/` | Non-sensitive contract definitions | Source-controlled; byte-drift tests |
| Recovery fixture inputs | `scripts/`, `tests/` | Synthetic states, change values, and confirmation flags | Fixture-only; resulting contract versions are covered below; no external action |
| Manual contract versions | `services/importer/`, unit tests, walking-path temporary JSON | Synthetic draft/active/degraded/violated versions and traveler-scoped fixture IDs | Local append-only fixture history; temporary walking/test directories are removed; not production storage |
| ReferenceTravel changes and recovery state | `packages/adapters/reference-travel/`, `services/monitor/`, tests | TEST PROVIDER synthetic assets/evidence, event IDs, version history, and case timelines | Contract versions use the temporary JSON repository; dedupe/case indexes are process-local and temporary paths are removed; no live response or external action |
| Configuration examples | `.env.example` | Safe placeholders, no credentials | `.env.local` and real environment files are Git-ignored |

## Not present or collected

No real confirmation email, traveler identity, accessibility need, provider response, evidence document, precise itinerary, account token, prompt, calendar content, or user research artifact is present. No database, analytics, log pipeline, model training set, or external transmission exists.

Access needs and travel evidence are sensitive future production data. Before live ingestion, the project still needs capture-mode consent, purpose limitation, encryption, object authorization, retention/deletion enforcement, export/correction, advocate scoping, prompt-injection defenses, and verified raw/derived artifact deletion.

Generated coverage/build output and local dependency directories are ignored. Real evidence, exports, credentials, and private provider material must never be committed as fixtures.
