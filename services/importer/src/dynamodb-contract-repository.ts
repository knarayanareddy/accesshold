import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";
import type { ContractRepository } from "./contract-repository.js";

interface ContractHead {
  pk: string;
  sk: "HEAD";
  itemType: "contract_head";
  tripId: string;
  travelerId: string;
  contractId: string;
  version: number;
  document: AccessContractDocument;
  gsi1pk: string;
  gsi1sk: string;
  deleted?: boolean;
}

interface ContractVersion {
  pk: string;
  sk: string;
  itemType: "contract_version";
  tripId: string;
  travelerId: string;
  contractId: string;
  version: number;
  document: AccessContractDocument;
}

function clone(document: AccessContractDocument): AccessContractDocument {
  return structuredClone(document);
}

function primaryKey(tripId: string): { pk: string; sk: "HEAD" } {
  return { pk: `TRIP#${tripId}`, sk: "HEAD" };
}

function versionKey(
  tripId: string,
  version: number,
): {
  pk: string;
  sk: string;
} {
  return {
    pk: `TRIP#${tripId}`,
    sk: `CONTRACT#${String(version).padStart(16, "0")}`,
  };
}

function decodeDocument(row: {
  document: unknown;
  tripId: string;
  version: number;
  contractId: string;
}): AccessContractDocument {
  let document: unknown = row.document;
  if (typeof document === "string") {
    try {
      document = JSON.parse(document) as unknown;
    } catch {
      throw new Error("dynamodb_contract_document_invalid");
    }
  }
  if (
    typeof document !== "object" ||
    document === null ||
    !("trip" in document) ||
    typeof document.trip !== "object" ||
    document.trip === null ||
    !("trip_id" in document.trip) ||
    document.trip.trip_id !== row.tripId ||
    !("version" in document) ||
    document.version !== row.version ||
    !("contract_id" in document) ||
    document.contract_id !== row.contractId
  ) {
    throw new Error("dynamodb_contract_row_mismatch");
  }
  return clone(document as AccessContractDocument);
}

function isConditionalCancellation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error))
    return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  if (error.name !== "TransactionCanceledException") return false;
  if (
    !("CancellationReasons" in error) ||
    !Array.isArray(error.CancellationReasons)
  )
    return true;
  return error.CancellationReasons.some((reason: unknown) => {
    if (typeof reason !== "object" || reason === null || !("Code" in reason))
      return false;
    return (
      reason.Code === "ConditionalCheckFailed" ||
      reason.Code === "TransactionConflict"
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * DynamoDB contract history adapter. It uses the shared workflow table's
 * `pk`/`sk` keys and the sparse `TravelerContractsIndex` GSI declared in CDK.
 */
export class DynamoDbContractRepository implements ContractRepository {
  private readonly client: Pick<DynamoDBDocumentClient, "send">;
  private readonly ownedClient: DynamoDBDocumentClient | undefined;

  constructor(
    private readonly tableName: string,
    client?: Pick<DynamoDBDocumentClient, "send">,
  ) {
    if (!tableName.trim())
      throw new Error("dynamodb_contract_table_name_required");
    if (client) {
      this.client = client;
      this.ownedClient = undefined;
    } else {
      const ownedClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
      this.client = ownedClient;
      this.ownedClient = ownedClient;
    }
  }

  close(): void {
    this.ownedClient?.destroy();
  }

  private async getHeadRaw(tripId: string): Promise<ContractHead | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: primaryKey(tripId),
        ConsistentRead: true,
      }),
    );
    const item = result.Item as ContractHead | undefined;
    if (!item) return undefined;
    if (item.itemType !== "contract_head" || item.tripId !== tripId)
      throw new Error("dynamodb_contract_head_invalid");
    return item;
  }

  async current(tripId: string): Promise<AccessContractDocument | undefined> {
    const head = await this.getHeadRaw(tripId);
    if (!head || head.deleted) return undefined;
    return decodeDocument(head);
  }

  private async queryVersions(tripId: string): Promise<ContractVersion[]> {
    const items: ContractVersion[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `TRIP#${tripId}`,
            ":prefix": "CONTRACT#",
          },
          ConsistentRead: true,
          ScanIndexForward: true,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      for (const item of result.Items ?? []) {
        const row = item as ContractVersion;
        if (row.itemType !== "contract_version" || row.tripId !== tripId)
          throw new Error("dynamodb_contract_version_invalid");
        items.push(row);
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);
    return items;
  }

  async versions(tripId: string): Promise<AccessContractDocument[]> {
    const head = await this.getHeadRaw(tripId);
    if (head?.deleted) return [];
    const items = await this.queryVersions(tripId);
    return items
      .sort((left, right) => left.version - right.version)
      .map((item) => decodeDocument(item));
  }

  async listCurrent(): Promise<AccessContractDocument[]> {
    const documents: AccessContractDocument[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression:
            "#itemType = :head AND (attribute_not_exists(#deleted) OR #deleted = :false)",
          ExpressionAttributeNames: {
            "#itemType": "itemType",
            "#deleted": "deleted",
          },
          ExpressionAttributeValues: {
            ":head": "contract_head",
            ":false": false,
          },
          ConsistentRead: true,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      for (const item of result.Items ?? []) {
        const head = item as ContractHead;
        documents.push(decodeDocument(head));
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);
    return documents;
  }

  async listCurrentForTraveler(
    travelerId: string,
  ): Promise<AccessContractDocument[]> {
    const documents: AccessContractDocument[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "TravelerContractsIndex",
          KeyConditionExpression:
            "gsi1pk = :traveler AND begins_with(gsi1sk, :tripPrefix)",
          ExpressionAttributeValues: {
            ":traveler": `TRAVELER#${travelerId}`,
            ":tripPrefix": "TRIP#",
          },
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      for (const item of result.Items ?? []) {
        const head = item as ContractHead;
        if (head.itemType !== "contract_head" || head.deleted) continue;
        if (typeof head.tripId !== "string" || head.travelerId !== travelerId)
          throw new Error("dynamodb_contract_traveler_index_mismatch");
        const authoritative = await this.getHeadRaw(head.tripId);
        if (!authoritative || authoritative.deleted) continue;
        if (authoritative.travelerId !== travelerId)
          throw new Error("dynamodb_contract_traveler_index_mismatch");
        documents.push(decodeDocument(authoritative));
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);
    return documents;
  }

  async append(
    document: AccessContractDocument,
    expectedVersion: number | null,
  ): Promise<void> {
    const expectedNewVersion =
      expectedVersion === null ? 1 : expectedVersion + 1;
    if (document.version !== expectedNewVersion)
      throw new Error("invalid_next_contract_version");
    const tripId = document.trip.trip_id;
    const head: ContractHead = {
      ...primaryKey(tripId),
      itemType: "contract_head",
      tripId,
      travelerId: document.traveler_id,
      contractId: document.contract_id,
      version: document.version,
      document: clone(document),
      gsi1pk: `TRAVELER#${document.traveler_id}`,
      gsi1sk: `TRIP#${tripId}`,
    };
    const history: ContractVersion = {
      ...versionKey(tripId, document.version),
      itemType: "contract_version",
      tripId,
      travelerId: document.traveler_id,
      contractId: document.contract_id,
      version: document.version,
      document: clone(document),
    };
    const headCondition =
      expectedVersion === null
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : {
            ConditionExpression:
              "#version = :expected AND (attribute_not_exists(#deleted) OR #deleted = :false)",
            ExpressionAttributeNames: {
              "#version": "version",
              "#deleted": "deleted",
            },
            ExpressionAttributeValues: {
              ":expected": expectedVersion,
              ":false": false,
            },
          };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: history,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: head,
                ...headCondition,
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalCancellation(error)) throw error;
      const actual = await this.getHeadRaw(tripId);
      if (expectedVersion === null && actual)
        throw new Error("trip_already_exists", { cause: error });
      if (expectedVersion !== null && actual?.deleted)
        throw new Error("trip_not_found", { cause: error });
      if (expectedVersion !== null && actual?.version !== expectedVersion)
        throw new Error("optimistic_version_conflict", { cause: error });
      throw new Error("contract_version_already_exists", { cause: error });
    }
  }

  private async deleteVersionBatch(
    requests: NonNullable<BatchWriteCommandInput["RequestItems"]>[string],
  ): Promise<void> {
    let pending = requests;
    for (let attempt = 0; pending.length > 0 && attempt < 6; attempt += 1) {
      const result = await this.client.send(
        new BatchWriteCommand({
          RequestItems: { [this.tableName]: pending },
        }),
      );
      pending = (result.UnprocessedItems?.[this.tableName] ??
        []) as typeof pending;
      if (pending.length > 0 && attempt < 5)
        await delay(Math.min(100 * 2 ** attempt, 1600));
    }
    if (pending.length > 0)
      throw new Error("dynamodb_contract_delete_retry_exhausted");
  }

  async deleteTrip(tripId: string, expectedVersion: number): Promise<number> {
    const key = primaryKey(tripId);
    let head = await this.getHeadRaw(tripId);
    if (!head) throw new Error("trip_not_found");
    if (head.version !== expectedVersion)
      throw new Error("optimistic_version_conflict");

    if (!head.deleted) {
      try {
        await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: key,
            UpdateExpression: "SET #deleted = :deleted",
            ConditionExpression:
              "#version = :expected AND attribute_not_exists(#deleted)",
            ExpressionAttributeNames: {
              "#version": "version",
              "#deleted": "deleted",
            },
            ExpressionAttributeValues: {
              ":expected": expectedVersion,
              ":deleted": true,
            },
          }),
        );
      } catch (error) {
        if (!isConditionalCancellation(error)) throw error;
        head = await this.getHeadRaw(tripId);
        if (!head) throw new Error("trip_not_found", { cause: error });
        if (head.version !== expectedVersion)
          throw new Error("optimistic_version_conflict", { cause: error });
        if (!head.deleted)
          throw new Error("dynamodb_contract_delete_conflict", {
            cause: error,
          });
      }
    }

    const versions = await this.queryVersions(tripId);
    for (let offset = 0; offset < versions.length; offset += 25) {
      const batch = versions.slice(offset, offset + 25).map((item) => ({
        DeleteRequest: {
          Key: { pk: item.pk, sk: item.sk },
        },
      }));
      await this.deleteVersionBatch(batch);
    }
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: key,
        ConditionExpression: "#version = :expected AND #deleted = :deleted",
        ExpressionAttributeNames: {
          "#version": "version",
          "#deleted": "deleted",
        },
        ExpressionAttributeValues: {
          ":expected": expectedVersion,
          ":deleted": true,
        },
      }),
    );
    return versions.length;
  }
}
