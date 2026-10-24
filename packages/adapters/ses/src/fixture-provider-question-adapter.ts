import { sha256Hex } from "../../../domain/src/hash.js";
import type {
  ProviderQuestionMailAdapter,
  ProviderQuestionMessage,
  ProviderQuestionReceipt,
} from "./types.js";

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
      message_id: `TEST-${sha256Hex(JSON.stringify(message)).slice(0, 20).toUpperCase()}`,
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
