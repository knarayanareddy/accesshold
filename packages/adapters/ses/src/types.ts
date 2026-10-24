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
