import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Pool, type PoolConfig } from "pg";
import { DynamoDbContractRepository } from "./dynamodb-contract-repository.js";
import type { ContractRepository } from "./contract-repository.js";
import { PostgresContractRepository } from "./postgres-contract-repository.js";

export interface ContractRepositoryHandle {
  repository: ContractRepository;
  close(): Promise<void>;
}

interface DatabaseCredentials {
  username?: string;
  user?: string;
  password?: string;
}

function databaseCredentials(raw: string | undefined): DatabaseCredentials {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("database_credentials_invalid");
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("database_credentials_invalid");
  const values = parsed as Record<string, unknown>;
  for (const key of ["username", "user", "password"] as const) {
    if (values[key] !== undefined && typeof values[key] !== "string")
      throw new Error("database_credentials_invalid");
  }
  return {
    ...(typeof values.username === "string"
      ? { username: values.username }
      : {}),
    ...(typeof values.user === "string" ? { user: values.user } : {}),
    ...(typeof values.password === "string"
      ? { password: values.password }
      : {}),
  };
}

export function createPostgresPoolConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  const credentials = databaseCredentials(env.DATABASE_CREDENTIALS);
  const tls =
    env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined;
  if (env.DATABASE_URL) {
    return {
      connectionString: env.DATABASE_URL,
      ...(tls ? { ssl: tls } : {}),
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    };
  }
  const host = env.DATABASE_HOST;
  const database = env.DATABASE_NAME;
  const port = Number.parseInt(env.DATABASE_PORT ?? "5432", 10);
  const user = credentials.username ?? credentials.user;
  if (
    !host ||
    !database ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    throw new Error("postgres_connection_configuration_required");
  if (!user || !credentials.password)
    throw new Error("database_credentials_required");
  return {
    host,
    database,
    port,
    user,
    password: credentials.password,
    ...(tls ? { ssl: tls } : {}),
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  };
}

/**
 * Creates a durable repository from explicit deployment configuration.
 * Fixture runtimes should continue to construct their fixture repository directly.
 */
export function createContractRepositoryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ContractRepositoryHandle {
  const driver = env.CONTRACT_REPOSITORY_DRIVER;
  if (driver === "postgres") {
    const pool = new Pool(createPostgresPoolConfig(env));
    return {
      repository: new PostgresContractRepository(pool),
      close: () => pool.end(),
    };
  }
  if (driver === "dynamodb") {
    const tableName = env.WORKFLOW_TABLE_NAME;
    if (!tableName)
      throw new Error("dynamodb_workflow_table_configuration_required");
    const sdkClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    const repository = new DynamoDbContractRepository(tableName, sdkClient);
    return {
      repository,
      close: async () => sdkClient.destroy(),
    };
  }
  throw new Error("contract_repository_driver_must_be_postgres_or_dynamodb");
}
