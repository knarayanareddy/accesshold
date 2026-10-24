export interface ProviderQuestionTemplate {
  feature: string;
  label: string;
  question: string;
}

export interface ProviderQuestionTemplateSet {
  version: string;
  templates: ProviderQuestionTemplate[];
}

export interface ProviderQuestionDraft {
  request_id: string;
  trip_id: string;
  contract_version: number;
  constraint_id: string;
  asset_id: string;
  provider: string;
  provider_reference: string;
  recipient: string;
  subject: string;
  body: string;
  template_version: string;
  created_at: string;
  expires_at: string;
  approval_hash: string;
  status: "draft";
  provenance: "fixture";
}
