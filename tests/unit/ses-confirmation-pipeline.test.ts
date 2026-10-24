import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AccessContractDocument } from "../../packages/contracts/src/index.js";
import type { FeatureRegistry } from "../../packages/policy-engine/src/index.js";
import type { ContractRepository } from "../../services/importer/src/contract-repository.js";
import {
  SesConfirmationConstraintPipeline,
  type TravelerImportProfile,
} from "../../services/importer/src/ses-confirmation-pipeline.js";
import type { ParsedSesEmail } from "../../services/importer/src/ses-parser.js";

function readJson<T>(relative: string): T {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../${relative}`, import.meta.url)),
      "utf8",
    ),
  ) as T;
}

const schema = readJson<object>("schemas/access-contract.schema.json");
const registry = readJson<FeatureRegistry>("content/feature-registry/v1.json");
const example = readJson<AccessContractDocument>(
  "examples/access-contract.example.json",
);
const travelerId = example.traveler_id;
const receivedAt = "2026-10-24T09:30:00.000Z";
const idempotencyKey = "a".repeat(64);

function parsedEmail(overrides: Partial<ParsedSesEmail> = {}): ParsedSesEmail {
  return {
    message_id: "ses-message-001",
    idempotency_key: idempotencyKey,
    from: "bookings@hotel.example.test",
    recipients: ["import+traveler@example.test"],
    subject: "Hotel reservation confirmation",
    sent_at: null,
    received_at: receivedAt,
    source_uri: "s3://accesshold-imports-test/inbound/ses-message-001",
    content_sha256: "b".repeat(64),
    text_body: "Hotel room reservation confirmed. Check-in 2026-11-01.",
    confirmation_kind: "hotel",
    attachments: [],
    contains_html: false,
    body_truncated: false,
    manual_review_reasons: [],
    ...overrides,
  };
}

class LiveMemoryContractRepository implements ContractRepository {
  private readonly versionsByTrip = new Map<string, AccessContractDocument[]>();

  async current(tripId: string): Promise<AccessContractDocument | undefined> {
    const versions = this.versionsByTrip.get(tripId);
    const current = versions?.at(-1);
    return current ? structuredClone(current) : undefined;
  }

  async versions(tripId: string): Promise<AccessContractDocument[]> {
    return structuredClone(this.versionsByTrip.get(tripId) ?? []);
  }

  async listCurrent(): Promise<AccessContractDocument[]> {
    return Promise.all(
      [...this.versionsByTrip.keys()].map(
        async (tripId) => (await this.current(tripId))!,
      ),
    );
  }

  async listCurrentForTraveler(id: string): Promise<AccessContractDocument[]> {
    return (await this.listCurrent()).filter(
      (document) => document.traveler_id === id,
    );
  }

  async append(
    document: AccessContractDocument,
    expectedVersion: number | null,
  ): Promise<void> {
    const history = this.versionsByTrip.get(document.trip.trip_id) ?? [];
    const current = history.at(-1);
    if (expectedVersion === null && current)
      throw new Error("trip_already_exists");
    if (expectedVersion !== null && current?.version !== expectedVersion)
      throw new Error("optimistic_version_conflict");
    if (document.version !== (expectedVersion ?? 0) + 1)
      throw new Error("invalid_next_contract_version");
    history.push(structuredClone(document));
    this.versionsByTrip.set(document.trip.trip_id, history);
  }

  async deleteTrip(tripId: string, expectedVersion: number): Promise<number> {
    const current = await this.current(tripId);
    if (!current) throw new Error("trip_not_found");
    if (current.version !== expectedVersion)
      throw new Error("optimistic_version_conflict");
    const count = this.versionsByTrip.get(tripId)?.length ?? 0;
    this.versionsByTrip.delete(tripId);
    return count;
  }
}

function profile(): TravelerImportProfile {
  return {
    approval_policy: structuredClone(example.approval_policy),
    constraints: [
      {
        traveler_text: "I need a roll-in shower without a raised lip.",
        priority: "hard",
        predicate: {
          feature: "hotel.room.roll_in_shower",
          operator: "eq",
          value: true,
        },
        applies_to_kinds: ["hotel_room"],
      },
    ],
  };
}

describe("SES confirmation constraint pipeline", () => {
  it("creates a validated, unverified contract draft from the existing traveler profile", async () => {
    const repository = new LiveMemoryContractRepository();
    const extracted = {
      title: "Amsterdam hotel stay",
      starts_at: example.trip.starts_at,
      ends_at: example.trip.ends_at,
      time_zone: example.trip.time_zone,
      assets: [
        {
          kind: "hotel_room" as const,
          provider: "Hotel Example",
          provider_reference: "H-98765",
          starts_at: example.assets[0]!.starts_at,
          ends_at: example.assets[0]!.ends_at,
        },
      ],
    };
    const itineraryExtractor = {
      extract: vi.fn().mockResolvedValue(extracted),
    };
    const profileProvider = {
      getProfile: vi.fn().mockResolvedValue(profile()),
    };
    let nextId = 1;
    const pipeline = new SesConfirmationConstraintPipeline({
      schema,
      registry,
      repository,
      profileProvider,
      itineraryExtractor,
      clock: () => new Date(receivedAt),
      idFactory: () => String(nextId++).padStart(26, "0"),
      tripIdFactory: () => "01J00000000000000000000003",
    });

    const imported = await pipeline.ingestConfirmation({
      travelerId,
      email: parsedEmail(),
      idempotencyKey,
    });
    const document = await repository.current(imported.tripId);
    expect(imported).toMatchObject({
      status: "imported",
      contractVersion: 1,
      contractStatus: "draft",
    });
    expect(document).toMatchObject({
      status: "draft",
      provenance: "live",
      trip: { source: "confirmation_email" },
      constraints: [
        {
          traveler_text: "I need a roll-in shower without a raised lip.",
          status: "unverified",
          evidence_ids: [],
        },
      ],
      evidence: [
        {
          source_type: "provider_document",
          verification_level: "documented",
          features: [],
          source_uri: "s3://accesshold-imports-test/inbound/ses-message-001",
          content_sha256: "b".repeat(64),
        },
      ],
    });
    expect(document?.assets[0]?.attributes).toEqual([]);
    expect(itineraryExtractor.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        travelerId,
        confirmationKind: "hotel",
        plainText: parsedEmail().text_body,
      }),
    );
    expect(profileProvider.getProfile).toHaveBeenCalledWith(travelerId);
  });

  it("deduplicates S3 retries by deterministic trip ID and raw-message hash", async () => {
    const repository = new LiveMemoryContractRepository();
    const itineraryExtractor = {
      extract: vi.fn().mockResolvedValue({
        title: "Amsterdam hotel stay",
        starts_at: example.trip.starts_at,
        ends_at: example.trip.ends_at,
        time_zone: example.trip.time_zone,
        assets: [
          {
            kind: "hotel_room",
            provider: "Hotel Example",
            provider_reference: "H-98765",
            starts_at: example.assets[0]!.starts_at,
            ends_at: example.assets[0]!.ends_at,
          },
        ],
      }),
    };
    let nextId = 1;
    const pipeline = new SesConfirmationConstraintPipeline({
      schema,
      registry,
      repository,
      profileProvider: { getProfile: vi.fn().mockResolvedValue(profile()) },
      itineraryExtractor,
      clock: () => new Date(receivedAt),
      idFactory: () => String(nextId++).padStart(26, "0"),
      tripIdFactory: () => "01J00000000000000000000003",
    });
    const input = { travelerId, email: parsedEmail(), idempotencyKey };
    const first = await pipeline.ingestConfirmation(input);
    const initial = await repository.current(first.tripId);
    expect(initial).toBeDefined();
    await repository.append(
      {
        ...initial!,
        status: "closed",
        version: 2,
        updated_at: "2026-10-25T09:30:00.000Z",
      },
      1,
    );
    const retry = await pipeline.ingestConfirmation(input);
    expect(first.status).toBe("imported");
    expect(retry).toMatchObject({
      status: "duplicate",
      tripId: first.tripId,
      contractVersion: 2,
      contractStatus: "closed",
    });
    expect(itineraryExtractor.extract).toHaveBeenCalledTimes(1);
  });

  it("refuses an inapplicable constraint profile and review-required content", async () => {
    const repository = new LiveMemoryContractRepository();
    const pipeline = new SesConfirmationConstraintPipeline({
      schema,
      registry,
      repository,
      profileProvider: {
        getProfile: vi.fn().mockResolvedValue({
          ...profile(),
          constraints: profile().constraints.map((item) => ({
            ...item,
            applies_to_kinds: ["flight" as const],
          })),
        }),
      },
      itineraryExtractor: {
        extract: vi.fn().mockResolvedValue({
          title: "Hotel stay",
          starts_at: example.trip.starts_at,
          ends_at: example.trip.ends_at,
          time_zone: example.trip.time_zone,
          assets: [
            {
              kind: "hotel_room",
              provider: "Hotel Example",
              provider_reference: "H-98765",
              starts_at: example.assets[0]!.starts_at,
              ends_at: example.assets[0]!.ends_at,
            },
          ],
        }),
      },
      clock: () => new Date(receivedAt),
      tripIdFactory: () => "01J00000000000000000000003",
    });
    await expect(
      pipeline.ingestConfirmation({
        travelerId,
        email: parsedEmail(),
        idempotencyKey,
      }),
    ).rejects.toThrow("ses_import_no_applicable_traveler_constraints");
    await expect(
      pipeline.ingestConfirmation({
        travelerId,
        email: parsedEmail({ manual_review_reasons: ["attachments_present"] }),
        idempotencyKey,
      }),
    ).rejects.toThrow("ses_import_requires_manual_review");
    expect(await repository.listCurrent()).toEqual([]);
  });
});
