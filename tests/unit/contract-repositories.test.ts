import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import { DynamoDbContractRepository } from "../../services/importer/src/dynamodb-contract-repository.js";
import { PostgresContractRepository } from "../../services/importer/src/postgres-contract-repository.js";

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

function nextVersion(
  document: AccessContractDocument,
  version: number,
): AccessContractDocument {
  return {
    ...structuredClone(document),
    version,
    updated_at: `2026-10-${String(23 + version).padStart(2, "0")}T12:00:00.000Z`,
  };
}

type FakeRow = {
  trip_id: string;
  version: number;
  document: AccessContractDocument;
};

class FakePostgresPool {
  readonly statements: string[] = [];
  private rows: FakeRow[] = [];

  private async execute<T extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.statements.push(sql.trim());
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    let rows: unknown[] = [];
    let rowCount = 0;
    if (normalized.startsWith("select version")) {
      const tripId = String(values[0]);
      const latest = this.rows
        .filter((row) => row.trip_id === tripId)
        .sort((left, right) => right.version - left.version)[0];
      rows = latest ? [{ version: latest.version }] : [];
    } else if (normalized.startsWith("select distinct on (trip_id)")) {
      const filtered = normalized.includes("where traveler_id")
        ? this.rows.filter((row) => row.document.traveler_id === values[0])
        : this.rows;
      const latest = new Map<string, FakeRow>();
      for (const row of filtered) {
        const current = latest.get(row.trip_id);
        if (!current || row.version > current.version)
          latest.set(row.trip_id, row);
      }
      rows = [...latest.values()].map((row) => ({
        trip_id: row.trip_id,
        version: row.version,
        document: structuredClone(row.document),
      }));
    } else if (normalized.startsWith("select trip_id, version, document")) {
      rows = this.rows
        .filter((row) => row.trip_id === values[0])
        .sort((left, right) =>
          normalized.includes("order by version desc")
            ? right.version - left.version
            : left.version - right.version,
        )
        .map((row) => ({
          trip_id: row.trip_id,
          version: row.version,
          document: structuredClone(row.document),
        }));
    } else if (normalized.startsWith("insert into")) {
      const document = JSON.parse(String(values[4])) as AccessContractDocument;
      this.rows.push({
        trip_id: String(values[0]),
        version: Number(values[1]),
        document,
      });
      rowCount = 1;
    } else if (normalized.startsWith("delete from")) {
      const tripId = String(values[0]);
      const before = this.rows.length;
      this.rows = this.rows.filter((row) => row.trip_id !== tripId);
      rowCount = before - this.rows.length;
    }
    return { rows: rows as T[], rowCount, command: "", oid: 0, fields: [] };
  }

  readonly query = <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> => this.execute<T>(sql, values);

  async connect() {
    return {
      query: this.query,
      release: () => undefined,
    };
  }
}

type DynamoItem = Record<string, unknown> & { pk: string; sk: string };

class FakeDynamoClient {
  private readonly items = new Map<string, DynamoItem>();
  private staleTravelerIndexItems: DynamoItem[] | undefined;

  returnStaleTravelerIndexFor(travelerId: string): void {
    this.staleTravelerIndexItems = [...this.items.values()]
      .filter((item) => item.gsi1pk === `TRAVELER#${travelerId}`)
      .map((item) => structuredClone(item));
  }

  private key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`;
  }

  private conditionalFailure(): Error {
    return Object.assign(new Error("conditional_failed"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
  }

  async send(command: { input: Record<string, unknown> }): Promise<unknown> {
    const input = command.input;
    if (command instanceof GetCommand) {
      const key = input.Key as { pk: string; sk: string };
      const item = this.items.get(this.key(key.pk, key.sk));
      return { Item: item ? structuredClone(item) : undefined };
    }
    if (command instanceof TransactWriteCommand) {
      const operations = input.TransactItems as Array<{
        Put: {
          Item: DynamoItem;
          ConditionExpression: string;
          ExpressionAttributeValues?: Record<string, unknown>;
        };
      }>;
      const historyPut = operations[0]!.Put;
      const headPut = operations[1]!.Put;
      const history = historyPut.Item;
      const head = headPut.Item;
      const existingHistory = this.items.get(this.key(history.pk, history.sk));
      const existingHead = this.items.get(this.key(head.pk, head.sk));
      if (existingHistory) throw this.conditionalFailure();
      if (headPut.ConditionExpression === "attribute_not_exists(pk)") {
        if (existingHead) throw this.conditionalFailure();
      } else {
        const expected = headPut.ExpressionAttributeValues?.[":expected"];
        if (
          !existingHead ||
          existingHead.version !== expected ||
          existingHead.deleted === true
        ) {
          throw this.conditionalFailure();
        }
      }
      this.items.set(
        this.key(history.pk, history.sk),
        structuredClone(history),
      );
      this.items.set(this.key(head.pk, head.sk), structuredClone(head));
      return {};
    }
    if (command instanceof QueryCommand) {
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      let matching: DynamoItem[];
      if (input.IndexName === "TravelerContractsIndex") {
        const source = this.staleTravelerIndexItems ?? [...this.items.values()];
        matching = source.filter((item) => item.gsi1pk === values[":traveler"]);
      } else {
        const pk = String(values[":pk"]);
        const prefix = String(values[":prefix"]);
        matching = [...this.items.values()].filter(
          (item) => item.pk === pk && item.sk.startsWith(prefix),
        );
      }
      matching.sort((left, right) => left.sk.localeCompare(right.sk));
      return { Items: matching.map((item) => structuredClone(item)) };
    }
    if (command instanceof ScanCommand) {
      return {
        Items: [...this.items.values()]
          .filter(
            (item) =>
              item.itemType === "contract_head" && item.deleted !== true,
          )
          .map((item) => structuredClone(item)),
      };
    }
    if (command instanceof UpdateCommand) {
      const key = input.Key as { pk: string; sk: string };
      const item = this.items.get(this.key(key.pk, key.sk));
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      if (
        !item ||
        item.version !== values[":expected"] ||
        item.deleted === true
      )
        throw this.conditionalFailure();
      item.deleted = values[":deleted"];
      return { Attributes: structuredClone(item) };
    }
    if (command instanceof BatchWriteCommand) {
      const requestItems = input.RequestItems as Record<
        string,
        Array<{ DeleteRequest: { Key: { pk: string; sk: string } } }>
      >;
      for (const request of Object.values(requestItems).flat()) {
        const key = request.DeleteRequest.Key;
        this.items.delete(this.key(key.pk, key.sk));
      }
      return { UnprocessedItems: {} };
    }
    if (command instanceof DeleteCommand) {
      const key = input.Key as { pk: string; sk: string };
      const item = this.items.get(this.key(key.pk, key.sk));
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      if (
        !item ||
        item.version !== values[":expected"] ||
        item.deleted !== values[":deleted"]
      ) {
        throw this.conditionalFailure();
      }
      this.items.delete(this.key(key.pk, key.sk));
      return {};
    }
    throw new Error(`unsupported_dynamodb_command:${command.constructor.name}`);
  }
}

describe("durable contract repository adapters", () => {
  it("uses transactional, version-checked PostgreSQL history and deletes the full trip atomically", async () => {
    const pool = new FakePostgresPool();
    const repository = new PostgresContractRepository(
      pool as unknown as Pool,
      "contract_versions_test",
    );
    const original = readExample();
    await repository.migrate();
    await repository.append(original, null);
    await repository.append(nextVersion(original, 2), 1);

    expect((await repository.current(original.trip.trip_id))?.version).toBe(2);
    expect(
      (await repository.versions(original.trip.trip_id)).map(
        (item) => item.version,
      ),
    ).toEqual([1, 2]);
    expect(
      await repository.listCurrentForTraveler(original.traveler_id),
    ).toHaveLength(1);
    expect(
      await repository.listCurrentForTraveler("01J00000000000000000000099"),
    ).toEqual([]);
    await expect(
      repository.append(nextVersion(original, 2), 1),
    ).rejects.toThrow("optimistic_version_conflict");
    expect(
      pool.statements.some((sql) => sql.includes("pg_advisory_xact_lock")),
    ).toBe(true);
    expect(pool.statements.some((sql) => sql.includes("$5::jsonb"))).toBe(true);
    expect(await repository.deleteTrip(original.trip.trip_id, 2)).toBe(2);
    await expect(
      repository.deleteTrip(original.trip.trip_id, 2),
    ).rejects.toThrow("trip_not_found");
  });

  it("uses DynamoDB transaction conditions, a traveler index, and resumable tombstone deletion", async () => {
    const dynamo = new FakeDynamoClient();
    const repository = new DynamoDbContractRepository(
      "workflow-test",
      dynamo as never,
    );
    const original = readExample();
    await repository.append(original, null);
    await repository.append(nextVersion(original, 2), 1);

    expect((await repository.current(original.trip.trip_id))?.version).toBe(2);
    expect(
      (await repository.versions(original.trip.trip_id)).map(
        (item) => item.version,
      ),
    ).toEqual([1, 2]);
    expect(await repository.listCurrent()).toHaveLength(1);
    expect(
      await repository.listCurrentForTraveler(original.traveler_id),
    ).toHaveLength(1);
    expect(
      await repository.listCurrentForTraveler("01J00000000000000000000099"),
    ).toEqual([]);
    await expect(
      repository.append(nextVersion(original, 2), 1),
    ).rejects.toThrow("optimistic_version_conflict");
    await expect(
      repository.deleteTrip(original.trip.trip_id, 1),
    ).rejects.toThrow("optimistic_version_conflict");
    dynamo.returnStaleTravelerIndexFor(original.traveler_id);
    expect(await repository.deleteTrip(original.trip.trip_id, 2)).toBe(2);
    expect(await repository.current(original.trip.trip_id)).toBeUndefined();
    expect(await repository.versions(original.trip.trip_id)).toEqual([]);
    expect(await repository.listCurrent()).toEqual([]);
    expect(
      await repository.listCurrentForTraveler(original.traveler_id),
    ).toEqual([]);
  });
});
