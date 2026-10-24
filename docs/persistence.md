# Contract persistence adapters

`ContractRepository` in `services/importer/src/contract-repository.ts` now has durable adapters for PostgreSQL and DynamoDB, with traveler-scoped current-trip listing. `InMemoryContractRepository` and `JsonFileFixtureContractRepository` remain for deterministic local fixtures only; they reject live documents and are not production persistence.

## PostgreSQL / Aurora

- `PostgresContractRepository` stores immutable JSONB contract versions in `accesshold_contract_versions`.
- `(trip_id, version)` is the primary key; `(contract_id, version)` is unique.
- An advisory transaction lock per trip serializes first writes and updates. `append` uses expected-version compare-and-swap and commits the new history row in one transaction. `deleteTrip` version-checks and removes the trip history in one transaction.
- `services/importer/migrations/001_contract_versions.sql` is the deployment migration. `make migrate-postgres` applies it in a transaction using the configured database credentials; `migrate()` is available for controlled setup/tests. Neither migration path should run on every API request.

## DynamoDB

`DynamoDbContractRepository` uses the existing `WorkflowStateTable` with `pk`/`sk` keys. Each trip has a `HEAD` item and immutable `CONTRACT#<version>` items. `TransactWrite` conditionally writes both the new version and head. Deletion first writes a version-checked tombstone, then removes history in bounded batches; retries can resume cleanup without exposing the tombstoned trip.

The workflow table now has a sparse `TravelerContractsIndex` GSI (`gsi1pk` / `gsi1sk`) for traveler-scoped listing. `listCurrent()` remains a paginated, strongly consistent scan intended for administrative retention jobs; request-path listing uses `listCurrentForTraveler()`. GSI propagation is eventually consistent, so new heads may take time to appear; returned index entries are reread strongly from the base table to suppress stale or deleted heads.

## Configuration and use

`createContractRepositoryFromEnvironment()` returns a repository plus a `close()` hook. Set `CONTRACT_REPOSITORY_DRIVER=postgres` with `DATABASE_URL`, or `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, and JSON `DATABASE_CREDENTIALS`. For DynamoDB, set `CONTRACT_REPOSITORY_DRIVER=dynamodb` and `WORKFLOW_TABLE_NAME`; AWS credentials and region use the standard SDK provider chain and `AWS_REGION`.

The local API still deliberately composes its fixture runtime and in-memory store. A production API/worker composition and Cognito JWT authorization are not enabled by this change. ECS task definitions declare the PostgreSQL driver, but no database connection or migration was exercised here.

## Validation boundary

Unit tests use deterministic fake clients for transaction/version behavior. `tests/integration/postgres-contract-repository.test.ts` runs against a disposable real PostgreSQL database when `ACCESSHOLD_TEST_DATABASE_URL` is set; it is skipped when no test database is configured. No PostgreSQL, LocalStack, or AWS integration was available during this implementation. See [`validation.md`](./validation.md).
