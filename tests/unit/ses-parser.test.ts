import { describe, expect, it, vi } from "vitest";
import {
  parseSesRawMime,
  parseSesS3Notification,
  SesInboundEmailHandler,
  type ConfirmationConstraintPipeline,
  type ParsedSesEmail,
  type SesConfirmationImportResult,
  type SesRawMimeObjectStore,
} from "../../services/importer/src/ses-parser.js";

const receivedAt = "2026-10-24T09:30:00.000Z";
const travelerId = "01J00000000000000000000001";
const flightConfirmation = Buffer.from(
  [
    "From: Bookings <confirmations@air.example.test>",
    "To: import+traveler@example.test",
    "Subject: Flight confirmation KL 1234",
    "Date: Sat, 24 Oct 2026 09:20:00 +0000",
    "Message-ID: <flight-1234@example.test>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="accesshold-test"',
    "",
    "--accesshold-test",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Your flight booking is confirmed.",
    "Flight KL 1234 departs AMS for LHR on 2026-11-04 at 10:20 UTC.",
    "Booking reference: ABC123.",
    "--accesshold-test",
    'Content-Type: text/html; charset="utf-8"',
    "",
    "<html><body><script>bad()</script>Flight KL 1234</body></html>",
    "--accesshold-test--",
    "",
  ].join("\r\n"),
);
const hotelConfirmation = Buffer.from(
  [
    "From: Stay Desk <stay@example.test>",
    "To: import+traveler@example.test",
    "Subject: Hotel room reservation",
    "Message-ID: <hotel-5678@example.test>",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Hotel reservation confirmed. Check-in 2026-11-04. Check-out 2026-11-07.",
    "Room booking reference HOTEL-5678.",
  ].join("\r\n"),
);

function s3Event(key = "inbound/message-123") {
  return {
    Records: [
      {
        eventSource: "aws:s3",
        eventName: "ObjectCreated:Put",
        eventTime: receivedAt,
        s3: {
          bucket: { name: "accesshold-imports-test" },
          object: { key: encodeURIComponent(key) },
        },
      },
    ],
  };
}

describe("SES inbound MIME parser", () => {
  it("parses flight confirmations, normalizes addresses, hashes the source, and never returns HTML", async () => {
    const parsed = await parseSesRawMime(
      flightConfirmation,
      {
        sourceUri: "s3://accesshold-imports-test/inbound/flight-1234",
        receivedAt,
      },
      { clock: () => new Date(receivedAt) },
    );

    expect(parsed).toMatchObject({
      message_id: "<flight-1234@example.test>",
      from: "confirmations@air.example.test",
      recipients: ["import+traveler@example.test"],
      subject: "Flight confirmation KL 1234",
      sent_at: "2026-10-24T09:20:00.000Z",
      received_at: receivedAt,
      confirmation_kind: "flight",
      source_uri: "s3://accesshold-imports-test/inbound/flight-1234",
      manual_review_reasons: [],
    });
    expect(parsed.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.idempotency_key).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.text_body).toContain("Flight KL 1234");
    expect(parsed.text_body).not.toContain("<script>");
    expect(parsed).not.toHaveProperty("html");
    expect(parsed).not.toHaveProperty("attachment_content");
  });

  it("classifies hotel confirmations without guessing from HTML-only content", async () => {
    const hotel = await parseSesRawMime(hotelConfirmation, { receivedAt });
    expect(hotel.confirmation_kind).toBe("hotel");
    expect(hotel.manual_review_reasons).toEqual([]);

    const htmlOnly = Buffer.from(
      [
        "From: stays@example.test",
        "To: import+traveler@example.test",
        "Subject: Reservation",
        "Message-ID: <html-only@example.test>",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<h1>Hotel reservation</h1>",
      ].join("\r\n"),
    );
    const parsed = await parseSesRawMime(htmlOnly, { receivedAt });
    expect(parsed.text_body).toBe("");
    expect(parsed.contains_html).toBe(true);
    expect(parsed.manual_review_reasons).toContain("html_only");
    expect(parsed.manual_review_reasons).toContain("unknown_confirmation_kind");
  });

  it("does not auto-ingest emails with attachments or oversized MIME", async () => {
    const withAttachment = Buffer.from(
      [
        "From: confirm@example.test",
        "To: import+traveler@example.test",
        "Subject: Hotel confirmation",
        "Message-ID: <hotel-attachment@example.test>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="mixed-boundary"',
        "",
        "--mixed-boundary",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Hotel booking confirmation, check-in 2026-11-04.",
        "--mixed-boundary",
        'Content-Type: application/pdf; name="booking.pdf"',
        "Content-Disposition: attachment; filename=" + '"../../booking.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0xLjQK",
        "--mixed-boundary--",
      ].join("\r\n"),
    );
    const parsed = await parseSesRawMime(withAttachment, { receivedAt });
    expect(parsed.confirmation_kind).toBe("hotel");
    expect(parsed.attachments).toEqual([
      expect.objectContaining({
        filename: "booking.pdf",
        content_type: "application/pdf",
      }),
    ]);
    expect(parsed.manual_review_reasons).toContain("attachments_present");
    await expect(
      parseSesRawMime(hotelConfirmation, {}, { maxRawBytes: 10 }),
    ).rejects.toThrow("ses_mime_payload_too_large");
  });

  it("validates S3 notifications and decodes event object keys safely", () => {
    expect(parseSesS3Notification(s3Event("inbound/room booking.eml"))).toEqual(
      [
        {
          bucket: "accesshold-imports-test",
          key: "inbound/room booking.eml",
          eventTime: receivedAt,
        },
      ],
    );
    expect(() =>
      parseSesS3Notification({
        Records: [
          {
            eventSource: "aws:s3",
            eventName: "ObjectRemoved:Delete",
            s3: {
              bucket: { name: "accesshold-imports-test" },
              object: { key: "inbound/message-123" },
            },
          },
        ],
      }),
    ).toThrow("ses_s3_event_source_invalid");
  });

  it("unwraps SQS batches containing direct S3 or SNS-wrapped notifications", () => {
    const directSqsEvent = {
      Records: [
        {
          eventSource: "aws:sqs",
          body: JSON.stringify(s3Event("inbound/direct.eml")),
        },
      ],
    };
    const snsBody = JSON.stringify({
      Type: "Notification",
      Message: JSON.stringify(s3Event("inbound/sns.eml")),
    });
    const snsSqsEvent = JSON.stringify({
      Records: [{ eventSource: "aws:sqs", body: snsBody }],
    });

    expect(parseSesS3Notification(directSqsEvent)).toEqual([
      {
        bucket: "accesshold-imports-test",
        key: "inbound/direct.eml",
        eventTime: receivedAt,
      },
    ]);
    expect(parseSesS3Notification(snsSqsEvent)).toEqual([
      {
        bucket: "accesshold-imports-test",
        key: "inbound/sns.eml",
        eventTime: receivedAt,
      },
    ]);
  });

  it("authorizes the recipient and routes safe confirmation into the idempotent constraint pipeline as a draft", async () => {
    const store: SesRawMimeObjectStore = {
      getRawMime: vi.fn().mockResolvedValue(flightConfirmation),
    };
    const seen: Array<{
      travelerId: string;
      email: ParsedSesEmail;
      idempotencyKey: string;
    }> = [];
    const processed = new Map<string, string>();
    const constraintPipeline: ConfirmationConstraintPipeline = {
      ingestConfirmation: vi.fn(
        async (
          input: Parameters<
            ConfirmationConstraintPipeline["ingestConfirmation"]
          >[0],
        ): Promise<SesConfirmationImportResult> => {
          seen.push(input);
          const prior = processed.get(input.idempotencyKey);
          if (prior)
            return {
              status: "duplicate",
              tripId: prior,
              contractVersion: 2,
              contractStatus: "active",
            };
          const tripId = "01J00000000000000000000002";
          processed.set(input.idempotencyKey, tripId);
          return {
            status: "imported",
            tripId,
            contractVersion: 1,
            contractStatus: "draft",
          };
        },
      ),
    };
    const handler = new SesInboundEmailHandler({
      allowedBuckets: new Set(["accesshold-imports-test"]),
      store,
      recipientResolver: {
        resolve: vi.fn(async ({ recipient, sender }) =>
          recipient === "import+traveler@example.test" &&
          sender === "confirmations@air.example.test"
            ? { travelerId }
            : undefined,
        ),
      },
      constraintPipeline,
    });

    const first = await handler.handle(s3Event());
    const second = await handler.handle(JSON.stringify(s3Event()));
    expect(first[0]).toMatchObject({
      status: "imported",
      trip_id: "01J00000000000000000000002",
      contract_version: 1,
    });
    expect(second[0]).toMatchObject({ status: "duplicate" });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.travelerId).toBe(travelerId);
    expect(seen[0]?.email.confirmation_kind).toBe("flight");
    expect(seen[0]?.idempotencyKey).toBe(seen[1]?.idempotencyKey);
    expect(seen[0]?.email.source_uri).toBe(
      "s3://accesshold-imports-test/inbound/message-123",
    );
  });

  it("rejects unauthorized buckets, object prefixes, and recipients before import", async () => {
    const store: SesRawMimeObjectStore = {
      getRawMime: vi.fn().mockResolvedValue(flightConfirmation),
    };
    const pipeline: ConfirmationConstraintPipeline = {
      ingestConfirmation: vi.fn(),
    };
    const handler = new SesInboundEmailHandler({
      allowedBuckets: new Set(["accesshold-imports-test"]),
      store,
      recipientResolver: { resolve: vi.fn().mockResolvedValue(undefined) },
      constraintPipeline: pipeline,
    });
    for (const allowedPrefix of ["inbound", "../inbound/", "inbound//"]) {
      expect(
        () =>
          new SesInboundEmailHandler({
            allowedBuckets: new Set(["accesshold-imports-test"]),
            allowedPrefix,
            store,
            recipientResolver: {
              resolve: vi.fn().mockResolvedValue(undefined),
            },
            constraintPipeline: pipeline,
          }),
      ).toThrow("ses_inbound_configuration_invalid");
    }
    await expect(handler.handle(s3Event("other/message-123"))).rejects.toThrow(
      "ses_s3_object_prefix_not_allowed",
    );
    await expect(
      handler.handle({
        Records: [
          {
            eventSource: "aws:s3",
            eventName: "ObjectCreated:Put",
            eventTime: receivedAt,
            s3: {
              bucket: { name: "untrusted-bucket" },
              object: { key: "inbound/message-123" },
            },
          },
        ],
      }),
    ).rejects.toThrow("ses_s3_bucket_not_allowed");
    await expect(handler.handle(s3Event())).rejects.toThrow(
      "ses_recipient_not_authorized_or_ambiguous",
    );
    expect(pipeline.ingestConfirmation).not.toHaveBeenCalled();
  });
});
