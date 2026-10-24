# SES inbound confirmation email ingestion

## Implemented boundary

`services/importer/src/ses-parser.ts` parses raw RFC 5322/MIME with `mailparser` and handles direct S3 object-created events, SQS Lambda event batches whose message bodies contain S3 events, and SNS `Message` wrappers (including SNS messages carried by SQS). This matches the configured SES receipt-rule path: SES stores the raw message under `inbound/` in the private imports bucket, then S3 emits an event to the inbound queue. It is not a public unauthenticated HTTP webhook.

The parser enforces an input-size limit, MIME-part/header limits, normalizes sender/recipient/subject, computes a SHA-256 content hash and idempotency key, and returns only plain text plus attachment metadata. HTML is never returned to the import pipeline. Unknown message types, HTML-only messages, truncated bodies, and messages with attachments are routed as `manual_review_required`; attachments must be scanned before they can enter extraction.

`SesInboundEmailHandler` checks the configured bucket and `inbound/` prefix, fetches raw MIME from S3, resolves exactly one authorized traveler recipient, and calls the typed `ConfirmationConstraintPipeline` with a stable idempotency key. `SesConfirmationConstraintPipeline` builds a schema-validated live contract draft from an injected itinerary extractor and the traveler’s existing, explicitly typed constraint profile. Constraints are remapped only to matching booked asset kinds and begin `unverified` with no feature evidence. The booking document is recorded as non-feature `provider_document` evidence; parser output never becomes an accessibility claim or approval. A deterministic trip ULID plus the raw-message hash makes S3 retries idempotent. Newly imported contracts must be drafts; a duplicate is acknowledged with its current contract status, even if a traveler has since reviewed or closed it, and is never rewritten or reopened.

## Required live composition

The handler is adapter-ready, but no SQS worker currently instantiates it in production. Before enabling real mail:

1. Implement the recipient resolver against traveler-authorized inbound aliases and enforce the applicable sender/envelope policy.
2. Compose the pipeline with the real traveler-profile store, a schema-validated extractor through the shared model gateway, durable `ContractRepository`, and the production recipient/SES envelope policy. The pipeline code is present, but no live profile provider or extractor is configured; all imported contracts must remain drafts until traveler review.
3. Add attachment scanning and a human-review path before allowing supported attachments.
4. Activate the SES receipt-rule set only after AWS identity, DNS/MX, retention, IAM, and security preflight.

No live SES message was received, no raw email was stored or sent, and no AWS resources were deployed. The tests use synthetic MIME fixtures and fake S3/recipient/pipeline adapters.
