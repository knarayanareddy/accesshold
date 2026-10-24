import { createHash } from "node:crypto";
import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandOutput,
} from "@aws-sdk/client-sesv2";
import type { ProviderQuestionDraft } from "../../../contracts/src/provider-question.js";

export interface ProviderQuestionMessage {
  request_id: string;
  recipient: string;
  subject: string;
  text_body: string;
}

export interface ProviderQuestionReceipt {
  request_id: string;
  message_id: string;
  accepted_at: string;
  status: "test_message_recorded" | "ses_accepted";
  provider: "TEST PROVIDER" | "Amazon SES";
  live_send: boolean;
  provider_confirmation_received: false;
}

export interface ProviderQuestionMailAdapter {
  sendQuestion(
    message: ProviderQuestionMessage,
  ): Promise<ProviderQuestionReceipt>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A local-only outbound adapter. It records, but never sends, email. */
export class FixtureProviderQuestionAdapter
  implements ProviderQuestionMailAdapter
{
  private readonly receipts = new Map<string, ProviderQuestionReceipt>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async sendQuestion(
    message: ProviderQuestionMessage,
  ): Promise<ProviderQuestionReceipt> {
    const existing = this.receipts.get(message.request_id);
    if (existing) return structuredClone(existing);
    if (
      !message.request_id.trim() ||
      !message.recipient.trim() ||
      !message.subject.trim() ||
      !message.text_body.trim()
    ) {
      throw new Error("invalid_fixture_provider_question");
    }
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("invalid_fixture_mail_clock");
    const receipt: ProviderQuestionReceipt = {
      request_id: message.request_id,
      message_id: `TEST-${digest(JSON.stringify(message)).slice(0, 20).toUpperCase()}`,
      accepted_at: now.toISOString(),
      status: "test_message_recorded",
      provider: "TEST PROVIDER",
      live_send: false,
      provider_confirmation_received: false,
    };
    this.receipts.set(message.request_id, receipt);
    return structuredClone(receipt);
  }

  get receiptCount(): number {
    return this.receipts.size;
  }
}

export interface SesProviderQuestionAdapterOptions {
  fromAddress: string;
  configurationSetName?: string;
}

/**
 * SESv2 plain-text sender. The approval gate is enforced by
 * ProviderQuestionService before this adapter can be reached from app flows.
 */
export class SesProviderQuestionAdapter implements ProviderQuestionMailAdapter {
  private readonly client: Pick<SESv2Client, "send">;

  constructor(
    private readonly options: SesProviderQuestionAdapterOptions,
    client: Pick<SESv2Client, "send"> = new SESv2Client({}),
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.fromAddress)) {
      throw new Error("ses_from_address_invalid");
    }
    this.client = client;
  }

  async sendQuestion(
    message: ProviderQuestionMessage,
  ): Promise<ProviderQuestionReceipt> {
    const command = new SendEmailCommand({
      FromEmailAddress: this.options.fromAddress,
      Destination: { ToAddresses: [message.recipient] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: { Text: { Data: message.text_body, Charset: "UTF-8" } },
        },
      },
      ...(this.options.configurationSetName
        ? { ConfigurationSetName: this.options.configurationSetName }
        : {}),
      EmailTags: [{ Name: "accesshold-request", Value: message.request_id }],
    });
    const result: SendEmailCommandOutput = await this.client.send(command);
    if (!result.MessageId) throw new Error("ses_message_id_missing");
    const now = this.clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("ses_mail_clock_invalid");
    return {
      request_id: message.request_id,
      message_id: result.MessageId,
      accepted_at: now.toISOString(),
      status: "ses_accepted",
      provider: "Amazon SES",
      live_send: true,
      provider_confirmation_received: false,
    };
  }

  static fromDraft(draft: ProviderQuestionDraft): ProviderQuestionMessage {
    return {
      request_id: draft.request_id,
      recipient: draft.recipient,
      subject: draft.subject,
      text_body: draft.body,
    };
  }
}
