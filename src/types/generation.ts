/** JSON is intentionally open-ended: model inputs and outputs come from its schema. */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export interface GenerationModel {
  id: string;
  object: "generation.model";
  display_name: string;
  category: string;
  description: string;
  status: string;
  available: boolean;
  transport: "queue" | "websocket" | "webrtc" | "unknown";
  queued_available: boolean;
  schema_available: boolean;
  schema_complete?: boolean;
  schema_issues?: Array<{ code: string; reference?: string }>;
  license: { [key: string]: JSONValue } | null;
  updated_at: string;
  pricing?: { [key: string]: JSONValue } | null;
  schema_url: string;
  [key: string]: unknown;
}
export interface GenerationModelList {
  object: "list";
  data: GenerationModel[];
  has_more: boolean;
  next_cursor: string | null;
  catalog: { last_updated_at: string | null; stale: boolean; total: number };
}
export interface GenerationModelListParams { q?: string; category?: string; status?: string; limit?: number; cursor?: string }
export type GenerationSchema = Record<string, unknown>;
export type GenerationJobStatus = "queued" | "submitting" | "running" | "succeeded" | "failed" | "cancelled" | "review";
export interface GenerationBilling {
  mode: "metered";
  status: "pending" | "settled" | "review";
  currency: "USD";
  markup_multiplier: number;
  cost_usd: number | null;
}
export interface GenerationJob {
  object: "generation.job";
  id: string;
  model: string;
  status: GenerationJobStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deadline_at: string;
  cancel_requested: boolean;
  error: { code: string; message: string } | null;
  billing: GenerationBilling;
  result_url: string | null;
  license?: { [key: string]: JSONValue } | null;
}
export interface GenerationSubmitParams {
  model: string;
  input: JSONValue;
  /** Explicit consent to variable metered billing. This is not a spending cap. */
  billing_mode: "metered";
  /** Reuse this UUID with the identical body after an ambiguous submission. */
  client_request_id?: string;
  timeout_seconds?: number;
}
export interface GenerationResult<T = JSONValue> { job_id: string; data: T; billing: GenerationBilling }
export interface GenerationPendingResult { data: GenerationJob }
export interface GenerationSubscription<T = JSONValue> { job: GenerationJob; result: GenerationResult<T> }
export type GenerationSessionStatus = "created" | "connecting" | "active" | "closing" | "closed" | "review";
export interface GenerationSession {
  object: "generation.session"; id: string; model: string; transport: "websocket" | "webrtc"; status: GenerationSessionStatus;
  created_at: string; updated_at: string; connected_at: string | null; completed_at: string | null; deadline_at: string | null;
  expires_at: string; max_duration_seconds: number; close_requested: boolean; error: { code: string; message: string } | null;
  billing: GenerationBilling; license: { [key: string]: JSONValue } | null;
}
export interface GenerationSessionCreateParams {
  model: string; transport: "websocket" | "webrtc"; billing_mode: "metered";
  client_request_id?: string; max_duration_seconds?: number;
}
export type GenerationSessionConnection = {
  transport: "websocket"; session_id?: string; websocket_url: string; token: string; expires_at: string;
  subprotocols: string[]; encoding: "json" | "msgpack";
} | { transport: "webrtc"; session_id?: string; url: string; token: string; expires_at: string };
export interface GenerationSessionOffer { type: "offer"; sdp: string }
export type GenerationSessionEvent = { event: "answer"; data: { session_id: string; type: "answer"; sdp: string } }
  | { event: "closed"; data: { session_id: string; reason: string } };
