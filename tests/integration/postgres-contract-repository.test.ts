import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import { PostgresContractRepository } from "../../services/importer/src/postgres-contract-repository.js";

const databaseUrl = process.env.ACCESSHOLD_TEST_DATABASE_URL;
const tableName = `accesshold_contract_it_${randomBytes(4).toString("hex")}`;
const describeDatabase = describe.skipIf(!databaseUrl);
let pool: Pool;
let repository: PostgresContractRepository;

function readExample(): AccessContractDocument {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../examples/access-contract.example.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as AccessContractDocument;
}

describeDatabase("PostgreSQL contract repository integration", () => {
  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    repository = new PostgresContractRepository(pool, tableName);
    await repository.migrate();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
      await pool.end();
    }
  });

  it("persists append-only versions, enforces compare-and-swap, scopes lists, and deletes atomically", async () => {
    const example = readExample();
    const next = {
      ...structuredClone(example),
      version: 2,
      updated_at: "2026-10-24T12:00:00.000Z",
    };
    await repository.append(example, null);
    await repository.append(next, 1);

    expect((await repository.current(example.trip.trip_id))?.version).toBe(2);
    expect(
      (await repository.versions(example.trip.trip_id)).map(
        (item) => item.version,
      ),
    ).toEqual([1, 2]);
    expect(
      await repository.listCurrentForTraveler(example.traveler_id),
    ).toHaveLength(1);
    expect(
      await repository.listCurrentForTraveler("01J00000000000000000000099"),
    ).toEqual([]);
    await expect(repository.append({ ...next, version: 3 }, 1)).rejects.toThrow(
      "optimistic_version_conflict",
    );
    expect(await repository.deleteTrip(example.trip.trip_id, 2)).toBe(2);
    expect(await repository.current(example.trip.trip_id)).toBeUndefined();
  });
});
