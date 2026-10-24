import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { createPostgresPoolConfig } from "../services/importer/src/contract-repository-factory.js";

export async function applyPostgresContractMigration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const pool = new Pool(createPostgresPoolConfig(env));
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const migration = await readFile(
      new URL(
        "../services/importer/migrations/001_contract_versions.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query("BEGIN");
    await client.query(migration);
    await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    throw new Error("postgres_contract_migration_failed", { cause: error });
  } finally {
    client?.release();
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await applyPostgresContractMigration();
  console.info("AccessHold contract migration applied.");
}
