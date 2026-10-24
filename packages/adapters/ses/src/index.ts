import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandOutput,
} from "@aws-sdk/client-sesv2";
import type { ProviderQuestionDraft } from "../../../contracts/src/provider-question.js";
import type {
  ProviderQuestionMailAdapter,
  ProviderQuestionMessage,
  ProviderQuestionReceipt,
} from "./types.js";

export type {
  ProviderQuestionMailAdapter,
  ProviderQuestionMessage,
  ProviderQuestionReceipt,
} from "./types.js";
export { FixtureProviderQuestionAdapter } from "./fixture-provider-question-adapter.js";

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
