import type { QueueRequestParams } from "./serverless.js";

export interface QueueRuntimeCapabilities { stage: "inactive"; execution_available: false; billing_available: false }
export interface QueueRuntimeCursor { created_at: string; id: string }
export interface QueueRuntimeListParams extends QueueRequestParams { limit?: number; after_created_at?: string; after_id?: string }
export interface QueueRuntimeEndpoint {
  id: string; draft_id: string; generation: number; profile_id: string; model: string;
  state: "prepared" | "dispatch_unknown" | "ready" | "stopping" | "deleted" | "cancelled";
  created_at: string; deleted_at: string | null; financial_exposure: "held" | "none"; requires_review: boolean;
}
export interface QueueRuntimeJob {
  id: string; endpoint_id: string; state: "prepared" | "dispatch_unknown" | "submitted" | "completed" | "failed" | "cancelled" | "expired";
  created_at: string; finished_at: string | null; result_available: boolean;
  financial_exposure: "held" | "none"; requires_review: boolean;
}
export interface QueueRuntimeEndpointList { items: QueueRuntimeEndpoint[]; next_cursor: QueueRuntimeCursor | null }
export interface QueueRuntimeJobList { items: QueueRuntimeJob[]; next_cursor: QueueRuntimeCursor | null }
export interface QueueRuntimeQuote {
  id: string; client_request_id: string; kind: "endpoint" | "job"; target_id: string; expires_at: string;
  currency: "USD";
  /** Exact USD decimal with six fractional digits. This estimate is not a provider spending cap. */
  estimated_cost_usd: string;
  funding_mode: "metered"; is_spending_cap: false;
}
export interface QueueRuntimeQuoteParams extends QueueRequestParams {
  /** Reuse this UUID with the resulting quote when launching or submitting. */
  client_request_id?: string;
}
export interface QueueRuntimeJobQuoteParams extends QueueRuntimeQuoteParams { input: { prompt: string; max_tokens: number } }
export interface QueueRuntimeLaunchParams extends QueueRequestParams {
  /** Opaque quote returned by endpoints.quote or jobs.quote. */
  quote_id: string;
  /** Persist this UUID for an explicit retry after an ambiguous response. */
  client_request_id?: string;
}
export interface QueueRuntimeJobCreateParams extends QueueRuntimeLaunchParams { input: { prompt: string; max_tokens: number } }
export interface QueueRuntimeStopResult { released: boolean; financial_exposure: "held" | "none" }
export type QueueRuntimeResult = { available: false } | { available: true; result: {
  text: string; finish_reason: "stop" | "length";
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
} };
