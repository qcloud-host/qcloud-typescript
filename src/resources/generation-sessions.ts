import { randomUUID } from "node:crypto";
import type { QCloudAI, RequestOptions } from "../client.js";
import { APIResponseValidationError, QCloudAIError } from "../error.js";
import type { GenerationSessionStream } from "../session-stream.js";
import type { GenerationSession, GenerationSessionConnection, GenerationSessionCreateParams, GenerationSessionOffer } from "../types/generation.js";
import { normalizeUuid } from "../uuid.js";
import { GenerationSocket, type GenerationSocketOptions } from "../session-socket.js";

const states = new Set(["created", "connecting", "active", "closing", "closed", "review"]);
function sessionId(value: string): string { return normalizeUuid(value, "session ID"); }
function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("data" in value) || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new APIResponseValidationError("Invalid session response envelope");
  return value.data as Record<string, unknown>;
}
function session(value: unknown, id?: string): GenerationSession {
  const result = data(value);
  if (result.object !== "generation.session" || typeof result.id !== "string" || !states.has(String(result.status)) || !["websocket", "webrtc"].includes(String(result.transport)) || !result.billing || (id !== undefined && result.id !== id)) throw new APIResponseValidationError("Invalid or mismatched generation session");
  return result as unknown as GenerationSession;
}
function connection(value: unknown, id: string): GenerationSessionConnection {
  const result = data(value);
  if (result.session_id !== undefined && result.session_id !== id) throw new APIResponseValidationError("Connection belongs to a different session");
  if (typeof result.token !== "string" || !result.token || typeof result.expires_at !== "string") throw new APIResponseValidationError("Invalid session capability");
  if (result.transport === "websocket" || (result.transport === "webrtc" && result.signaling === "websocket")) {
    if ((result.signaling !== undefined && result.signaling !== "websocket") || typeof result.websocket_url !== "string" || !result.websocket_url || !Array.isArray(result.subprotocols) || !result.subprotocols.length || !result.subprotocols.every(item => typeof item === "string" && item.length > 0) || !["json", "msgpack"].includes(String(result.encoding))) throw new APIResponseValidationError("Invalid WebSocket session capability");
    if (result.transport === "webrtc" && (result.protocol !== "rtc-signaling-v1" || result.encoding !== "msgpack")) throw new APIResponseValidationError("Unsupported WebRTC signaling protocol");
  } else if (result.transport !== "webrtc" || (result.signaling !== undefined && result.signaling !== "sse") || typeof result.url !== "string" || !result.url) throw new APIResponseValidationError("Invalid WebRTC session capability");
  return result as unknown as GenerationSessionConnection;
}
export class GenerationSessions {
  constructor(private client: QCloudAI) {}
  /** Open one raw-frame native socket. No codec, retry, reconnect or WebRTC peer. */
  openSocket(id: string, options: GenerationSocketOptions = {}): Promise<GenerationSocket> {
    id = sessionId(id);
    return GenerationSocket.open(id, this.client.baseURL, options,
      timeout => this.connect(id, { signal: options.signal, timeout, maxRetries: 0 }),
      timeout => this.close(id, { timeout, maxRetries: 0 }));
  }
  async create(params: GenerationSessionCreateParams, options?: RequestOptions): Promise<GenerationSession> {
    if (params.billing_mode !== "metered") throw new TypeError("billing_mode:'metered' is required");
    if (!params.model || !["websocket", "webrtc"].includes(params.transport)) throw new TypeError("A model and supported session transport are required");
    const requestId = normalizeUuid(params.client_request_id ?? randomUUID(), "client_request_id");
    if (params.max_duration_seconds !== undefined && (!Number.isInteger(params.max_duration_seconds) || params.max_duration_seconds < 1 || params.max_duration_seconds > 3600)) throw new TypeError("max_duration_seconds must be an integer from 1 to 3600");
    const body = { model: params.model, transport: params.transport, billing_mode: "metered", client_request_id: requestId, ...(params.max_duration_seconds === undefined ? {} : { max_duration_seconds: params.max_duration_seconds }) };
    try { return session(await this.client._request("POST", "/generation/sessions", { ...options, body, maxRetries: 0 })); }
    catch (error) { if (error instanceof QCloudAIError) error.clientRequestId = requestId; throw error; }
  }
  async retrieve(id: string, options?: RequestOptions): Promise<GenerationSession> { id = sessionId(id); return session(await this.client._request("GET", `/generation/sessions/${id}`, options), id); }
  async connect(id: string, options?: RequestOptions): Promise<GenerationSessionConnection> { id = sessionId(id); return connection(await this.client._request("POST", `/generation/sessions/${id}/connect`, { ...options, maxRetries: 0 }), id); }
  async close(id: string, options?: RequestOptions): Promise<GenerationSession> { id = sessionId(id); return session(await this.client._request("POST", `/generation/sessions/${id}/close`, { ...options, maxRetries: 0 }), id); }
  offer(id: string, params: GenerationSessionOffer, options: RequestOptions & { sessionToken: string }): Promise<GenerationSessionStream> {
    id = sessionId(id);
    if (params.type !== "offer" || typeof params.sdp !== "string" || !params.sdp || !options.sessionToken || /[\r\n]/.test(options.sessionToken)) throw new TypeError("An SDP offer and session token are required");
    return this.client._request("POST", `/generation/sessions/${id}/offer`, { ...options, body: { type: "offer", sdp: params.sdp }, headers: { ...options.headers, "X-QCloud-Session-Token": options.sessionToken }, maxRetries: 0, stream: true, sessionId: id });
  }
}
