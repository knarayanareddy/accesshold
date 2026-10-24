import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { simpleParser, type AddressObject } from "mailparser";
import type { AccessContractDocument } from "../../../packages/contracts/src/index.js";

const DEFAULT_MAX_RAW_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARACTERS = 100_000;
const MAX_S3_RECORDS = 10;

export type ConfirmationKind = "flight" | "hotel" | "mixed" | "unknown";

export interface SesAttachmentMetadata {
  filename: string | null;
  content_type: string;
  size_bytes: number;
}

/** Safe mail envelope for the booking-import pipeline; no HTML or attachment bytes. */
export interface ParsedSesEmail {
  message_id: string;
  idempotency_key: string;
  from: string;
  recipients: string[];
  subject: string;
  sent_at: string | null;
  received_at: string;
  source_uri: string | null;
  content_sha256: string;
  text_body: string;
  confirmation_kind: ConfirmationKind;
  attachments: SesAttachmentMetadata[];
  contains_html: boolean;
  body_truncated: boolean;
  manual_review_reasons: Array<
    | "unknown_confirmation_kind"
    | "attachments_present"
    | "html_only"
    | "body_truncated"
  >;
}

export interface SesMimeMetadata {
  sourceUri?: string;
  sesMessageId?: string;
  receivedAt?: string;
}

export interface SesMimeParserOptions {
  maxRawBytes?: number;
  maxTextCharacters?: number;
  clock?: () => Date;
}

function replaceControlCharacters(
  value: string,
  preserveLineBreaks: boolean,
): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const allowedWhitespace =
      preserveLineBreaks && (codePoint === 9 || codePoint === 10);
    result +=
      codePoint === 127 || (codePoint <= 31 && !allowedWhitespace)
        ? " "
        : character;
  }
  return result;
}

function cleanHeader(value: string, maxLength: number): string {
  return replaceControlCharacters(value, false)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanBody(value: string): string {
  return replaceControlCharacters(value.replace(/\r\n?/g, "\n"), true)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
}

function mailboxAddresses(
  header: AddressObject | AddressObject[] | undefined,
): string[] {
  if (!header) return [];
  const objects = Array.isArray(header) ? header : [header];
  const addresses: string[] = [];
  const visit = (object: AddressObject["value"][number]): void => {
    if (object.address) {
      const address = cleanHeader(object.address, 320).toLowerCase();
      if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))
        addresses.push(address);
    }
    for (const member of object.group ?? []) visit(member);
  };
  for (const object of objects) {
    for (const value of object.value) visit(value);
  }
  return [...new Set(addresses)];
}

function classifyConfirmation(subject: string, body: string): ConfirmationKind {
  const content = `${subject}\n${body}`;
  const flight =
    /\b(flight|airline|boarding pass|e[- ]?ticket|departure|arrival|airport|pnr|itinerary)\b/i.test(
      content,
    ) || /\b[A-Z]{2}\s?\d{1,4}\b/.test(content);
  const hotel =
    /\b(hotel|room|check[- ]?in|check[- ]?out|guest|accommodation|property reservation)\b/i.test(
      content,
    );
  if (flight && hotel) return "mixed";
  if (flight) return "flight";
  if (hotel) return "hotel";
  return "unknown";
}

function isoTimestamp(value: Date | undefined): string | null {
  if (!value || !Number.isFinite(value.getTime())) return null;
  return value.toISOString();
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Parses raw RFC 5322/MIME without exposing active HTML or attachment contents. */
export async function parseSesRawMime(
  rawMime: Uint8Array,
  metadata: SesMimeMetadata = {},
  options: SesMimeParserOptions = {},
): Promise<ParsedSesEmail> {
  const maxRawBytes = options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
  const maxTextCharacters =
    options.maxTextCharacters ?? DEFAULT_MAX_TEXT_CHARACTERS;
  if (
    !Number.isSafeInteger(maxRawBytes) ||
    maxRawBytes < 1 ||
    !Number.isSafeInteger(maxTextCharacters) ||
    maxTextCharacters < 1
  ) {
    throw new Error("ses_parser_limits_invalid");
  }
  if (!(rawMime instanceof Uint8Array) || rawMime.byteLength === 0)
    throw new Error("ses_mime_payload_empty");
  if (rawMime.byteLength > maxRawBytes)
    throw new Error("ses_mime_payload_too_large");

  let parsed;
  try {
    parsed = await simpleParser(Buffer.from(rawMime), {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
      keepCidLinks: true,
      ignoreEmbedded: true,
      maxChildNodes: 200,
      maxHeadSize: 64 * 1024,
      maxHtmlLengthToParse: 0,
      checksumAlgo: false,
    });
  } catch (error) {
    throw new Error("ses_mime_parse_failed", { cause: error });
  }

  const fromAddresses = mailboxAddresses(parsed.from);
  if (fromAddresses.length !== 1) throw new Error("ses_from_address_invalid");
  const recipients = mailboxAddresses(parsed.to);
  if (recipients.length === 0) throw new Error("ses_recipient_missing");
  if (recipients.length > 10) throw new Error("ses_recipient_count_exceeded");

  const contentHash = hash(rawMime);
  const headerMessageId = cleanHeader(parsed.messageId ?? "", 512);
  const messageId = cleanHeader(metadata.sesMessageId ?? headerMessageId, 512);
  if (!messageId) throw new Error("ses_message_id_missing");

  const now = options.clock?.() ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new Error("ses_parser_clock_invalid");
  const receivedAt = metadata.receivedAt ? new Date(metadata.receivedAt) : now;
  if (!Number.isFinite(receivedAt.getTime()))
    throw new Error("ses_received_at_invalid");

  const decodedBody = cleanBody(parsed.text ?? "");
  const bodyTruncated = decodedBody.length > maxTextCharacters;
  const textBody = decodedBody.slice(0, maxTextCharacters);
  const hasPlainText = textBody.length > 0;
  const containsHtml = typeof parsed.html === "string";
  const attachments = parsed.attachments.map((attachment) => ({
    filename: attachment.filename
      ? cleanHeader(
          attachment.filename.replaceAll("\\", "/").split("/").pop() ?? "",
          128,
        ) || null
      : null,
    content_type: cleanHeader(attachment.contentType, 128).toLowerCase(),
    size_bytes: attachment.size,
  }));
  const confirmationKind = classifyConfirmation(
    cleanHeader(parsed.subject ?? "", 256),
    textBody,
  );
  const manualReviewReasons: ParsedSesEmail["manual_review_reasons"] = [];
  if (confirmationKind === "unknown")
    manualReviewReasons.push("unknown_confirmation_kind");
  if (attachments.length > 0) manualReviewReasons.push("attachments_present");
  if (!hasPlainText && containsHtml) manualReviewReasons.push("html_only");
  if (bodyTruncated) manualReviewReasons.push("body_truncated");
  const idempotencyKey = hash(
    `accesshold-ses-v1\0${messageId}\0${contentHash}`,
  );

  return {
    message_id: messageId,
    idempotency_key: idempotencyKey,
    from: fromAddresses[0]!,
    recipients,
    subject: cleanHeader(parsed.subject ?? "", 256),
    sent_at: parsed.headerLines.some((line) => line.key === "date")
      ? isoTimestamp(parsed.date)
      : null,
    received_at: receivedAt.toISOString(),
    source_uri: metadata.sourceUri ?? null,
    content_sha256: contentHash,
    text_body: textBody,
    confirmation_kind: confirmationKind,
    attachments,
    contains_html: containsHtml,
    body_truncated: bodyTruncated,
    manual_review_reasons: manualReviewReasons,
  };
}

export interface SesS3NotificationRecord {
  bucket: string;
  key: string;
  eventTime: string;
}

function recordFromUnknown(value: unknown): SesS3NotificationRecord {
  if (typeof value !== "object" || value === null)
    throw new Error("ses_s3_event_record_invalid");
  const record = value as Record<string, unknown>;
  if (
    record.eventSource !== "aws:s3" ||
    typeof record.eventName !== "string" ||
    !record.eventName.startsWith("ObjectCreated:")
  ) {
    throw new Error("ses_s3_event_source_invalid");
  }
  const s3 = record.s3;
  if (typeof s3 !== "object" || s3 === null)
    throw new Error("ses_s3_event_record_invalid");
  const location = s3 as Record<string, unknown>;
  const bucket = location.bucket;
  const object = location.object;
  if (typeof bucket !== "object" || bucket === null)
    throw new Error("ses_s3_bucket_invalid");
  if (typeof object !== "object" || object === null)
    throw new Error("ses_s3_object_invalid");
  const bucketName = (bucket as Record<string, unknown>).name;
  const encodedKey = (object as Record<string, unknown>).key;
  if (typeof bucketName !== "string" || !bucketName.trim())
    throw new Error("ses_s3_bucket_invalid");
  if (typeof encodedKey !== "string" || !encodedKey)
    throw new Error("ses_s3_object_key_invalid");
  let key: string;
  try {
    key = decodeURIComponent(encodedKey.replaceAll("+", " "));
  } catch (error) {
    throw new Error("ses_s3_object_key_invalid", { cause: error });
  }
  if (
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\u0000") ||
    key.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("ses_s3_object_key_invalid");
  }
  if (
    typeof record.eventTime !== "string" ||
    !Number.isFinite(new Date(record.eventTime).getTime())
  ) {
    throw new Error("ses_s3_event_time_invalid");
  }
  return {
    bucket: bucketName,
    key,
    eventTime: new Date(record.eventTime).toISOString(),
  };
}

function parseJsonEnvelope(value: string, errorCode: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
}

function parseNotificationPayload(
  input: unknown,
  depth = 0,
): SesS3NotificationRecord[] {
  if (depth > 3) throw new Error("ses_ingress_envelope_depth_exceeded");
  const value =
    typeof input === "string"
      ? parseJsonEnvelope(
          input,
          depth === 0
            ? "ses_s3_notification_json_invalid"
            : "ses_sqs_message_json_invalid",
        )
      : input;
  if (typeof value !== "object" || value === null)
    throw new Error("ses_s3_notification_invalid");
  const wrapper = value as Record<string, unknown>;
  if (wrapper.Type === "Notification") {
    if (typeof wrapper.Message !== "string")
      throw new Error("ses_s3_notification_message_invalid");
    return parseNotificationPayload(wrapper.Message, depth + 1);
  }

  const records = wrapper.Records;
  if (!Array.isArray(records) || records.length === 0)
    throw new Error("ses_s3_notification_record_count_invalid");
  const containsSqsRecord = records.some(
    (record) =>
      typeof record === "object" &&
      record !== null &&
      "eventSource" in record &&
      record.eventSource === "aws:sqs",
  );
  if (containsSqsRecord) {
    if (records.length > MAX_S3_RECORDS)
      throw new Error("ses_sqs_record_count_invalid");
    const s3Records: SesS3NotificationRecord[] = [];
    for (const record of records) {
      if (
        typeof record !== "object" ||
        record === null ||
        !("eventSource" in record) ||
        record.eventSource !== "aws:sqs" ||
        !("body" in record) ||
        typeof record.body !== "string"
      ) {
        throw new Error("ses_sqs_event_record_invalid");
      }
      s3Records.push(...parseNotificationPayload(record.body, depth + 1));
      if (s3Records.length > MAX_S3_RECORDS)
        throw new Error("ses_s3_notification_record_count_invalid");
    }
    return s3Records;
  }
  if (records.length > MAX_S3_RECORDS)
    throw new Error("ses_s3_notification_record_count_invalid");
  return records.map(recordFromUnknown);
}

/** Accepts S3 events directly, in SQS Lambda records, or wrapped via SNS. */
export function parseSesS3Notification(
  input: unknown,
): SesS3NotificationRecord[] {
  return parseNotificationPayload(input);
}

export interface SesRawMimeObjectStore {
  getRawMime(
    bucket: string,
    key: string,
    maxBytes: number,
  ): Promise<Uint8Array>;
}

/** S3 source used by the SES receipt-rule S3 -> SQS ingestion path. */
export class S3SesRawMimeObjectStore implements SesRawMimeObjectStore {
  private readonly client: Pick<S3Client, "send">;
  private readonly ownedClient: S3Client | undefined;

  constructor(client?: Pick<S3Client, "send">) {
    if (client) {
      this.client = client;
      this.ownedClient = undefined;
    } else {
      const ownedClient = new S3Client({});
      this.client = ownedClient;
      this.ownedClient = ownedClient;
    }
  }

  close(): void {
    this.ownedClient?.destroy();
  }

  async getRawMime(
    bucket: string,
    key: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const result = (await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )) as GetObjectCommandOutput;
    if (!result.Body) throw new Error("ses_s3_object_body_missing");
    if (
      typeof result.ContentLength !== "number" ||
      result.ContentLength < 1 ||
      result.ContentLength > maxBytes
    ) {
      throw new Error("ses_mime_payload_too_large");
    }
    const bytes = await result.Body.transformToByteArray();
    if (
      bytes.byteLength !== result.ContentLength ||
      bytes.byteLength > maxBytes
    )
      throw new Error("ses_s3_object_size_mismatch");
    return bytes;
  }
}

export interface AuthorizedEmailRecipient {
  travelerId: string;
}

export interface SesImportRecipientResolver {
  resolve(input: {
    recipient: string;
    sender: string;
  }): Promise<AuthorizedEmailRecipient | undefined>;
}

export interface SesConfirmationImportResult {
  status: "imported" | "duplicate";
  tripId: string;
  contractVersion: number;
  contractStatus: AccessContractDocument["status"];
}

/** Must validate/extract booked assets, apply the owner's existing constraints, and persist idempotently. */
export interface ConfirmationConstraintPipeline {
  ingestConfirmation(input: {
    travelerId: string;
    email: ParsedSesEmail;
    idempotencyKey: string;
  }): Promise<SesConfirmationImportResult>;
}

export interface SesInboundHandlerOptions {
  allowedBuckets: ReadonlySet<string>;
  allowedPrefix?: string;
  maxRawBytes?: number;
  store: SesRawMimeObjectStore;
  recipientResolver: SesImportRecipientResolver;
  constraintPipeline: ConfirmationConstraintPipeline;
  mimeParser?: typeof parseSesRawMime;
}

export interface SesInboundHandlingResult {
  bucket: string;
  object_key: string;
  status: "imported" | "duplicate" | "manual_review_required";
  trip_id?: string;
  contract_version?: number;
  reason?: string;
  idempotency_key: string;
}

/**
 * Boundary handler for S3 object-created events emitted by the configured SES
 * receipt rule. SQS delivery is at-least-once; the downstream pipeline must
 * enforce uniqueness on `idempotencyKey` before persisting a contract draft.
 */
export class SesInboundEmailHandler {
  private readonly maxRawBytes: number;
  private readonly prefix: string;
  private readonly parse: typeof parseSesRawMime;

  constructor(private readonly options: SesInboundHandlerOptions) {
    this.maxRawBytes = options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
    this.prefix = options.allowedPrefix ?? "inbound/";
    const prefixSegments = this.prefix.endsWith("/")
      ? this.prefix.slice(0, -1).split("/")
      : [];
    if (
      !Number.isSafeInteger(this.maxRawBytes) ||
      this.maxRawBytes < 1 ||
      options.allowedBuckets.size === 0 ||
      !this.prefix.endsWith("/") ||
      this.prefix.startsWith("/") ||
      this.prefix.includes("\\") ||
      this.prefix.includes("\u0000") ||
      prefixSegments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    ) {
      throw new Error("ses_inbound_configuration_invalid");
    }
    this.parse = options.mimeParser ?? parseSesRawMime;
  }

  async handle(input: unknown): Promise<SesInboundHandlingResult[]> {
    const records = parseSesS3Notification(input);
    const results: SesInboundHandlingResult[] = [];
    for (const record of records) {
      if (!this.options.allowedBuckets.has(record.bucket))
        throw new Error("ses_s3_bucket_not_allowed");
      if (!record.key.startsWith(this.prefix))
        throw new Error("ses_s3_object_prefix_not_allowed");
      const rawMime = await this.options.store.getRawMime(
        record.bucket,
        record.key,
        this.maxRawBytes,
      );
      const sourceUri = `s3://${record.bucket}/${record.key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      const email = await this.parse(
        rawMime,
        {
          sourceUri,
          sesMessageId: record.key,
          ...(record.eventTime ? { receivedAt: record.eventTime } : {}),
        },
        { maxRawBytes: this.maxRawBytes },
      );
      const authorized: AuthorizedEmailRecipient[] = [];
      for (const recipient of email.recipients) {
        const resolved = await this.options.recipientResolver.resolve({
          recipient,
          sender: email.from,
        });
        if (resolved?.travelerId.trim()) authorized.push(resolved);
      }
      const uniqueTravelerIds = [
        ...new Set(authorized.map((item) => item.travelerId)),
      ];
      if (uniqueTravelerIds.length !== 1)
        throw new Error("ses_recipient_not_authorized_or_ambiguous");

      if (email.manual_review_reasons.length > 0) {
        results.push({
          bucket: record.bucket,
          object_key: record.key,
          status: "manual_review_required",
          reason: email.manual_review_reasons[0] ?? "unknown_confirmation_kind",
          idempotency_key: email.idempotency_key,
        });
        continue;
      }

      const imported = await this.options.constraintPipeline.ingestConfirmation(
        {
          travelerId: uniqueTravelerIds[0]!,
          email,
          idempotencyKey: email.idempotency_key,
        },
      );
      const validStatuses: ReadonlySet<AccessContractDocument["status"]> =
        new Set([
          "draft",
          "active",
          "degraded",
          "violated",
          "recovering",
          "closed",
        ]);
      if (
        !["imported", "duplicate"].includes(imported.status) ||
        !validStatuses.has(imported.contractStatus) ||
        (imported.status === "imported" &&
          imported.contractStatus !== "draft") ||
        !Number.isSafeInteger(imported.contractVersion) ||
        imported.contractVersion < 1 ||
        !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(imported.tripId)
      ) {
        throw new Error("ses_import_pipeline_must_create_reviewable_draft");
      }
      results.push({
        bucket: record.bucket,
        object_key: record.key,
        status: imported.status,
        trip_id: imported.tripId,
        contract_version: imported.contractVersion,
        idempotency_key: email.idempotency_key,
      });
    }
    return results;
  }
}
