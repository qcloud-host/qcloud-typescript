export interface Model {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  display_name?: string;
  provider?: string;
  provider_model_id?: string;
  context_length?: number;
  max_output_tokens?: number;
  modality?: string;
  capabilities?: string[];
  pricing?: { input_per_million: number; output_per_million: number };
  catalog_verified_at?: string;
  stale?: boolean;
  [key: string]: unknown;
}

export interface ModelList {
  object: "list";
  data: Model[];
  catalog?: {
    last_updated_at: string | null;
    stale: boolean;
    providers: { provider: string; last_updated_at: string | null; stale: boolean }[];
  };
  [key: string]: unknown;
}
