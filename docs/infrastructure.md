# Infrastructure scaffold

`infra/` contains a CDK v2 TypeScript application and assertion tests for the requested AWS resource graph. It is **synthesis-validated only**: no AWS account was contacted, no resource was deployed, and the stack must not be treated as production-ready.

## Local checks

```bash
make test-infra       # CDK TypeScript check, assertions, and synthesis
make synth-infra      # synthesis only; output is written to ignored cdk.out/
```

These commands are offline apart from reading installed CDK packages. They do not perform `cdk bootstrap`, `cdk deploy`, `cdk diff`, push an image, modify DNS, activate SES, or create AWS resources.

## Resource graph

`AccessHoldStack` defines a two-AZ VPC with public, private-compute, and isolated-data subnets; an internet-facing HTTPS ALB; ECS Fargate API and worker services; Aurora PostgreSQL; encrypted DynamoDB workflow/idempotency tables (with a sparse traveler-contract GSI); encrypted SQS queues and DLQs; Step Functions deletion/retention queue workflows; a daily EventBridge schedule; Cognito user pool, hosted domain, and authorization-code client; SES identity and inbound receipt rule; Secrets Manager; KMS; private S3 imports/evidence/exports/web/access-log buckets; CloudFront OAC, security headers, SPA routing, and uncached HTTPS API/MCP behaviors; CloudWatch dashboards/alarms; and an AWS Budget notification.

Data-at-rest settings are explicit: inbound raw email and web assets use S3-managed AES-256 encryption; evidence and exports use S3-managed KMS encryption; the access-log bucket uses AES-256. The customer-managed application key is used for Aurora, DynamoDB, SQS, ECR, CloudWatch Logs, and integration secrets. Buckets block public access; application buckets write server-access logs to a dedicated destination. Inbound S3 objects under `inbound/` are configured to notify the encrypted import queue.

## Required deployment inputs

CloudFormation parameters are intentionally required for environment-specific values:

| Parameter | Requirement |
| --- | --- |
| `AlbCertificateArn` | ACM certificate in the stack region, valid for `ApiDomainName` |
| `ApiDomainName` | DNS name mapped to the ALB; also used for CloudFront's HTTPS API origin |
| `CloudFrontCertificateArn` | ACM certificate in `us-east-1`, valid for `WebDomainName` |
| `WebDomainName` | DNS name mapped to the CloudFront distribution |
| `ContainerImageTag` | Lowercase Git SHA (7–40 hex characters) already pushed to the immutable `accesshold/app` ECR repository |
| `SesIdentityName` | SES email/domain identity, with account verification and required DNS records completed |
| `BudgetAlertEmail` | Email address for the budget notification |
| `MonthlyBudgetUsd` | Monthly AWS spend threshold; defaults to USD 500 |

S3 bucket names include the AWS account and region. DNS validation/records, certificate creation, SES identity verification, SES receipt-rule-set activation, ECR image publication, web asset upload, and ACM/domain ownership remain external release tasks.

## Explicit gaps before deployment

- The current API is fixture-authenticated and returns `503` for production identity. Cognito resources exist, but JWT validation, traveler-to-Cognito identity mapping, sign-in/callback handling, and production authorization are not wired.
- The ECS task definitions reference an immutable image tag, but this repository does not yet provide a Dockerfile, image build/publish pipeline, or production entrypoints. In particular, `WORKER_MODE=queue-consumer` is a deployment contract, not evidence that a durable worker currently consumes those queues.
- Aurora is created without a schema migration task. PostgreSQL and DynamoDB `ContractRepository` adapters and a controlled SQL migration now exist, but the production API/worker composition does not inject them; no database connection or migration was exercised.
- SES resources are declared, `services/importer/src/ses-parser.ts` handles raw MIME plus S3/SQS/SNS ingress envelopes, and `services/importer/src/ses-confirmation-pipeline.ts` builds schema-validated drafts. No production SQS worker, authorized-recipient resolver, real itinerary extractor, traveler-profile provider, or durable import-idempotency ledger is composed. The receipt rule set is not activated, no live mail was tested, and the existing application runtime selects the fixture mail adapter.
- The deletion and retention state machines enqueue messages, but the deployed queue consumer, durable task state, and every required deletion scope (including viewer tokens and cached prompts) are not yet connected. The local S3 deletion adapter is not sufficient evidence of end-to-end production erasure.
- Provider secrets are placeholders only. No travel provider, calendar, Bedrock, Alexa+ account, or human-handoff channel is configured.
- DNS is not managed by this stack, and deployment/rollback, migrations, restore, accessibility, security, and operational runbooks still require review.

The stack is therefore useful for reviewing and testing the intended resource graph, not for launching a live service. Do not deploy it without completing those gaps and an explicit release preflight.
