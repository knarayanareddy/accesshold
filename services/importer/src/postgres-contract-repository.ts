import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";
import type { ContractRepository } from "./contract-repository.js";
import type { Pool } from "pg";

interface ContractRow {
  trip_id: string;
  version: number;
  document: unknown;
}

function clone(document: AccessContractDocument): AccessContractDocument {
  return structuredClone(document);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,39}$/.test(value))
    throw new Error("postgres_contract_table_name_invalid");
  return `"${value}"`;
}

function indexIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw new Error("postgres_contract_index_name_invalid");
  return `"${value}"`;
}

function toDocument(row: ContractRow): AccessContractDocument {
  let document: unknown = row.document;
  if (typeof document === "string") {
    try {
      document = JSON.parse(document) as unknown;
    } catch {
      throw new Error("postgres_contract_document_invalid");
    }
  }
  if (
    typeof document !== "object" ||
    document === null ||
    !("trip" in document) ||
    typeof document.trip !== "object" ||
    document.trip === null ||
    !("trip_id" in document.trip) ||
    document.trip.trip_id !== row.trip_id ||
    !("version" in document) ||
    document.version !== row.version
  ) {
    throw new Error("postgres_contract_row_mismatch");
  }
  return clone(document as AccessContractDocument);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

/** Aurora/PostgreSQL append-only contract-version storage. */
export class PostgresContractRepository implements ContractRepository {
  private readonly table: string;

  constructor(
    private readonly pool: Pick<Pool, "query" | "connect">,
    tableName = "accesshold_contract_versions",
  ) {
    this.table = identifier(tableName);
  }

  /** Run by the deployment migration job, not on every API request. */
  async migrate(): Promise<void> {
    const tableName = this.table;
    const indexName = indexIdentifier(
      `${tableName.slice(1, -1).slice(0, 34)}_traveler_version_idx`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        trip_id text NOT NULL,
        version integer NOT NULL CHECK (version > 0),
        contract_id text NOT NULL,
        traveler_id text NOT NULL,
        document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
        created_at timestamptz NOT NULL,
        PRIMARY KEY (trip_id, version),
        UNIQUE (contract_id, version),
        CHECK (document->'trip'->>'trip_id' = trip_id),
        CHECK ((document->>'version')::integer = version),
        CHECK (document->>'traveler_id' = traveler_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${indexName}
      ON ${tableName} (traveler_id, trip_id, version DESC)
    `);
  }

  async current(tripId: string): Promise<AccessContractDocument | undefined> {
    const result = await this.pool.query<ContractRow>(
      `SELECT trip_id, version, document
       FROM ${this.table}
       WHERE trip_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [tripId],
    );
    const row = result.rows[0];
    return row ? toDocument(row) : undefined;
  }

  async versions(tripId: string): Promise<AccessContractDocument[]> {
    const result = await this.pool.query<ContractRow>(
      `SELECT trip_id, version, document
       FROM ${this.table}
       WHERE trip_id = $1
       ORDER BY version ASC`,
      [tripId],
    );
    return result.rows.map(toDocument);
  }

  async listCurrent(): Promise<AccessContractDocument[]> {
    const result = await this.pool.query<ContractRow>(
      `SELECT DISTINCT ON (trip_id) trip_id, version, document
       FROM ${this.table}
       ORDER BY trip_id, version DESC`,
    );
    return result.rows.map(toDocument);
  }

  async listCurrentForTraveler(
    travelerId: string,
  ): Promise<AccessContractDocument[]> {
    const result = await this.pool.query<ContractRow>(
      `SELECT DISTINCT ON (trip_id) trip_id, version, document
       FROM ${this.table}
       WHERE traveler_id = $1
       ORDER BY trip_id, version DESC`,
      [travelerId],
    );
    return result.rows.map(toDocument);
  }

  async append(
    document: AccessContractDocument,
    expectedVersion: number | null,
  ): Promise<void> {
    const expectedNewVersion =
      expectedVersion === null ? 1 : expectedVersion + 1;
    if (document.version !== expectedNewVersion)
      throw new Error("invalid_next_contract_version");

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      // This also serializes first writes, where there is no row to FOR UPDATE.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [document.trip.trip_id],
      );
      const currentResult = await client.query<{ version: number }>(
        `SELECT version
         FROM ${this.table}
         WHERE trip_id = $1
         ORDER BY version DESC
         LIMIT 1
         FOR UPDATE`,
        [document.trip.trip_id],
      );
      const currentVersion = currentResult.rows[0]?.version;
      if (expectedVersion === null && currentVersion !== undefined)
        throw new Error("trip_already_exists");
      if (expectedVersion !== null && currentVersion !== expectedVersion)
        throw new Error("optimistic_version_conflict");

      await client.query(
        `INSERT INTO ${this.table}
          (trip_id, version, contract_id, traveler_id, document, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
        [
          document.trip.trip_id,
          document.version,
          document.contract_id,
          document.traveler_id,
          JSON.stringify(document),
          document.created_at,
        ],
      );
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen)
        await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(error))
        throw new Error("contract_version_already_exists", { cause: error });
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteTrip(tripId: string, expectedVersion: number): Promise<number> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [tripId],
      );
      const currentResult = await client.query<{ version: number }>(
        `SELECT version
         FROM ${this.table}
         WHERE trip_id = $1
         ORDER BY version DESC
         LIMIT 1
         FOR UPDATE`,
        [tripId],
      );
      const currentVersion = currentResult.rows[0]?.version;
      if (currentVersion === undefined) throw new Error("trip_not_found");
      if (currentVersion !== expectedVersion)
        throw new Error("optimistic_version_conflict");
      const deleted = await client.query(
        `DELETE FROM ${this.table} WHERE trip_id = $1`,
        [tripId],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return deleted.rowCount ?? 0;
    } catch (error) {
      if (transactionOpen)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
