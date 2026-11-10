import { randomUUID } from "node:crypto";
import type { QCloudAI, RequestOptions } from "../client.js";
import { APIResponseValidationError } from "../error.js";
import { normalizeUuid as normalizeLegacyUuid } from "../uuid.js";
import type { QueueRequestParams } from "../types/serverless.js";
import type { QueueRuntimeCapabilities, QueueRuntimeCursor, QueueRuntimeEndpoint, QueueRuntimeEndpointList, QueueRuntimeJob,
  QueueRuntimeJobList, QueueRuntimeLaunchParams, QueueRuntimeJobCreateParams, QueueRuntimeListParams, QueueRuntimeResult, QueueRuntimeStopResult,
  QueueRuntimeQuote, QueueRuntimeQuoteParams, QueueRuntimeJobQuoteParams } from "../types/queue-runtime.js";

const prefix = "/serverless/queue/runtime";
function normalizeUuid(value: string, field: string): string {
  const normalized = normalizeLegacyUuid(value, field);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(normalized))
    throw new TypeError(`${field} must be an RFC UUID with version 1 to 8`);
  return normalized;
}
const invalid = (): never => { throw new APIResponseValidationError("The API returned an invalid queue runtime response"); };
const object = (v: unknown): Record<string, unknown> => !v || typeof v !== "object" || Array.isArray(v) ? invalid() : v as Record<string, unknown>;
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const match = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.exec(value)?.[0] === value;
const timestamp = (v: unknown): v is string => match(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/, v)
  && Number.isFinite(Date.parse(v)) && new Date(v.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) === v.slice(0, 10);
const nullableTime = (v: unknown): v is string | null => v === null || timestamp(v);
function id(v: unknown): string { try { return normalizeUuid(v as string, "resource ID"); } catch { return invalid(); } }
function text(v: unknown, min: number, max: number): v is string {
  if (typeof v !== "string" || v.includes("\0") || v.length > max) return false;
  for (let i = 0; i < v.length; i++) {
    const unit = v.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = v.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  const bytes = Buffer.byteLength(v, "utf8"); return bytes >= min && bytes <= max;
}
function exposure(v: unknown): "held" | "none" { return v === "held" || v === "none" ? v : invalid(); }
function quote(value: unknown, kind: "endpoint" | "job", target: string, requestId: string): QueueRuntimeQuote {
  const v = object(value), quoteId = id(v.id), targetId = id(v.target_id), clientRequestId = id(v.client_request_id);
  if (v.kind !== kind || targetId !== target || clientRequestId !== requestId || !timestamp(v.expires_at)
    || v.currency !== "USD" || v.funding_mode !== "metered" || v.is_spending_cap !== false
    || !match(/^(?:0|[1-9][0-9]{0,9})\.[0-9]{6}$/, v.estimated_cost_usd)) return invalid();
  const micro = BigInt(v.estimated_cost_usd.replace(".", ""));
  if (micro < 1n || micro > 9007199254740991n) return invalid();
  return { id: quoteId, client_request_id: clientRequestId, kind, target_id: targetId, expires_at: v.expires_at,
    currency: "USD", estimated_cost_usd: v.estimated_cost_usd, funding_mode: "metered", is_spending_cap: false };
}
function endpoint(value: unknown, expected?: string, draft?: string): QueueRuntimeEndpoint {
  const v = object(value), resourceId = id(v.id), draftId = id(v.draft_id);
  if ((expected && resourceId !== expected) || (draft && draftId !== draft) || !integer(v.generation, 1, 2147483647)
    || !match(/^[a-z0-9][a-z0-9-]{1,62}$/, v.profile_id) || !match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, v.model)
    || !["prepared", "dispatch_unknown", "ready", "stopping", "deleted", "cancelled"].includes(v.state as string)
    || !timestamp(v.created_at) || !nullableTime(v.deleted_at) || typeof v.requires_review !== "boolean") return invalid();
  return { id: resourceId, draft_id: draftId, generation: v.generation, profile_id: v.profile_id, model: v.model,
    state: v.state as QueueRuntimeEndpoint["state"], created_at: v.created_at, deleted_at: v.deleted_at,
    financial_exposure: exposure(v.financial_exposure), requires_review: v.requires_review };
}
function job(value: unknown, expectedEndpoint: string, expected?: string): QueueRuntimeJob {
  const v = object(value), resourceId = id(v.id), endpointId = id(v.endpoint_id);
  if ((expected && resourceId !== expected) || endpointId !== expectedEndpoint
    || !["prepared", "dispatch_unknown", "submitted", "completed", "failed", "cancelled", "expired"].includes(v.state as string)
    || !timestamp(v.created_at) || !nullableTime(v.finished_at) || typeof v.requires_review !== "boolean" || typeof v.result_available !== "boolean"
    || (v.result_available && v.state !== "completed")) return invalid();
  return { id: resourceId, endpoint_id: endpointId, state: v.state as QueueRuntimeJob["state"], created_at: v.created_at,
    finished_at: v.finished_at, result_available: v.result_available, financial_exposure: exposure(v.financial_exposure), requires_review: v.requires_review };
}
function parameters(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("Unsupported queue runtime parameter");
  return value as Record<string, unknown>;
}
function query(params: QueueRequestParams | QueueRuntimeListParams, page = false): string {
  const p = parameters(params, page ? ["org_id", "limit", "after_created_at", "after_id"] : ["org_id"]), values = new URLSearchParams();
  if (p.org_id !== undefined) values.set("org_id", normalizeUuid(p.org_id as string, "org_id"));
  if (page) {
    if (p.limit !== undefined) { if (!integer(p.limit, 1, 50)) throw new TypeError("limit must be an integer from 1 to 50"); values.set("limit", String(p.limit)); }
    if ((p.after_created_at === undefined) !== (p.after_id === undefined)) throw new TypeError("Both cursor fields are required");
    if (p.after_created_at !== undefined) {
      if (!timestamp(p.after_created_at)) throw new TypeError("Invalid cursor timestamp");
      values.set("after_created_at", p.after_created_at); values.set("after_id", normalizeUuid(p.after_id as string, "after_id"));
    }
  }
  return values.size ? "?" + values.toString() : "";
}
function page<T extends { id: string; created_at: string }>(value: unknown, parse: (v: unknown) => T, limit = 20): { items: T[]; next_cursor: QueueRuntimeCursor | null } {
  const v = object(value);
  if (!Array.isArray(v.items) || v.items.length > limit) return invalid();
  const items = v.items.map(value => parse(value)); if (new Set(items.map(item => item.id)).size !== items.length) return invalid();
  let next_cursor: QueueRuntimeCursor | null = null;
  if (v.next_cursor !== null) {
    const cursor = object(v.next_cursor), last = items.at(-1), cursorId = id(cursor.id);
    if (!last || !timestamp(cursor.created_at) || cursor.created_at !== last.created_at || cursorId !== last.id) return invalid();
    next_cursor = { id: cursorId, created_at: cursor.created_at };
  }
  return { items, next_cursor };
}
async function withIdentity<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof Error && Object.isExtensible(error)) (error as Error & { clientRequestId?: string }).clientRequestId = requestId;
    throw error;
  }
}
function createBody(params: QueueRuntimeLaunchParams | QueueRuntimeJobCreateParams | QueueRuntimeQuoteParams | QueueRuntimeJobQuoteParams,
  requestId: string, isJob: boolean, isQuote = false): Record<string, unknown> {
  parameters(params, ["client_request_id", "org_id", ...(isQuote ? [] : ["quote_id"]), ...(isJob ? ["input"] : [])]);
  const body: Record<string, unknown> = { client_request_id: requestId };
  if (!isQuote) body.quote_id = normalizeUuid((params as QueueRuntimeLaunchParams).quote_id, "quote_id");
  if (params.org_id !== undefined) body.org_id = normalizeUuid(params.org_id, "org_id");
  if (isJob) {
    const input = parameters((params as QueueRuntimeJobCreateParams).input, ["prompt", "max_tokens"]);
    if (!text(input.prompt, 1, 16384) || !integer(input.max_tokens, 1, 4096)) throw new TypeError("Invalid bounded queue text input");
    body.input = { prompt: input.prompt, max_tokens: input.max_tokens };
  }
  return body;
}
export class QueueRuntimeEndpoints {
  constructor(private client: QCloudAI) {}
  async quote(draftId: string, params: QueueRuntimeQuoteParams = {}, options?: RequestOptions): Promise<QueueRuntimeQuote> {
    const requestId = normalizeUuid(params?.client_request_id ?? randomUUID(), "client_request_id");
    return withIdentity(requestId, async () => {
      draftId = normalizeUuid(draftId, "draft ID"); const body = createBody(params, requestId, false, true);
      return quote(object(await this.client._request("POST", `${prefix}/deployments/${draftId}/quote`, { ...options, maxRetries: 0, body })).data,
        "endpoint", draftId, requestId);
    });
  }
  async launch(draftId: string, params: QueueRuntimeLaunchParams, options?: RequestOptions): Promise<QueueRuntimeEndpoint> {
    const requestId = normalizeUuid(params?.client_request_id ?? randomUUID(), "client_request_id");
    return withIdentity(requestId, async () => {
      draftId = normalizeUuid(draftId, "draft ID"); const body = createBody(params, requestId, false);
      return endpoint(object(await this.client._request("POST", `${prefix}/deployments/${draftId}/launch`, { ...options, maxRetries: 0, body })).data, undefined, draftId);
    });
  }
  async list(params: QueueRuntimeListParams = {}, options?: RequestOptions): Promise<QueueRuntimeEndpointList> {
    const suffix = query(params, true); return page(await this.client._request("GET", `${prefix}/endpoints${suffix}`, options), endpoint, params.limit);
  }
  async retrieve(endpointId: string, params: QueueRequestParams = {}, options?: RequestOptions): Promise<QueueRuntimeEndpoint> {
    endpointId = normalizeUuid(endpointId, "endpoint ID"); return endpoint(object(await this.client._request("GET", `${prefix}/endpoints/${endpointId}${query(params)}`, options)).data, endpointId);
  }
  async stop(endpointId: string, params: QueueRequestParams = {}, options?: RequestOptions): Promise<QueueRuntimeStopResult> {
    endpointId = normalizeUuid(endpointId, "endpoint ID"); query(params);
    const body = params.org_id === undefined ? {} : { org_id: normalizeUuid(params.org_id, "org_id") };
    const v = object(await this.client._request("POST", `${prefix}/endpoints/${endpointId}/stop`, { ...options, maxRetries: 0, body }));
    const financial_exposure = exposure(v.financial_exposure);
    if (typeof v.released !== "boolean" || (v.released && financial_exposure !== "none")) return invalid();
    return { released: v.released, financial_exposure };
  }
}
export class QueueRuntimeJobs {
  constructor(private client: QCloudAI) {}
  async quote(endpointId: string, params: QueueRuntimeJobQuoteParams, options?: RequestOptions): Promise<QueueRuntimeQuote> {
    const requestId = normalizeUuid(params?.client_request_id ?? randomUUID(), "client_request_id");
    return withIdentity(requestId, async () => {
      endpointId = normalizeUuid(endpointId, "endpoint ID"); const body = createBody(params, requestId, true, true);
      return quote(object(await this.client._request("POST", `${prefix}/endpoints/${endpointId}/jobs/quote`, { ...options, maxRetries: 0, body })).data,
        "job", endpointId, requestId);
    });
  }
  async create(endpointId: string, params: QueueRuntimeJobCreateParams, options?: RequestOptions): Promise<QueueRuntimeJob> {
    const requestId = normalizeUuid(params?.client_request_id ?? randomUUID(), "client_request_id");
    return withIdentity(requestId, async () => {
      endpointId = normalizeUuid(endpointId, "endpoint ID"); const body = createBody(params, requestId, true);
      return job(object(await this.client._request("POST", `${prefix}/endpoints/${endpointId}/jobs`, { ...options, maxRetries: 0, body })).data, endpointId);
    });
  }
  async list(endpointId: string, params: QueueRuntimeListParams = {}, options?: RequestOptions): Promise<QueueRuntimeJobList> {
    endpointId = normalizeUuid(endpointId, "endpoint ID"); const suffix = query(params, true);
    return page(await this.client._request("GET", `${prefix}/endpoints/${endpointId}/jobs${suffix}`, options), value => job(value, endpointId), params.limit);
  }
  async retrieve(endpointId: string, jobId: string, params: QueueRequestParams = {}, options?: RequestOptions): Promise<QueueRuntimeJob> {
    endpointId = normalizeUuid(endpointId, "endpoint ID"); jobId = normalizeUuid(jobId, "job ID");
    return job(object(await this.client._request("GET", `${prefix}/endpoints/${endpointId}/jobs/${jobId}${query(params)}`, options)).data, endpointId, jobId);
  }
  async result(endpointId: string, jobId: string, params: QueueRequestParams = {}, options?: RequestOptions): Promise<QueueRuntimeResult> {
    endpointId = normalizeUuid(endpointId, "endpoint ID"); jobId = normalizeUuid(jobId, "job ID");
    const v = object(await this.client._request("GET", `${prefix}/endpoints/${endpointId}/jobs/${jobId}/result${query(params)}`, options));
    if (v.available === false) return { available: false };
    if (v.available !== true) return invalid(); const result = object(v.result), usage = object(result.usage);
    if (!text(result.text, 0, 65536) || !["stop", "length"].includes(result.finish_reason as string) || !integer(usage.input_tokens, 0, 32768)
      || !integer(usage.output_tokens, 0, 4096) || !integer(usage.total_tokens, 0, 32768) || usage.input_tokens + usage.output_tokens !== usage.total_tokens) return invalid();
    return { available: true, result: { text: result.text, finish_reason: result.finish_reason as "stop" | "length",
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens } } };
  }
}
export class ServerlessQueueRuntime {
  readonly endpoints: QueueRuntimeEndpoints; readonly jobs: QueueRuntimeJobs;
  constructor(private client: QCloudAI) { this.endpoints = new QueueRuntimeEndpoints(client); this.jobs = new QueueRuntimeJobs(client); }
  async capabilities(params: QueueRequestParams = {}, options?: RequestOptions): Promise<QueueRuntimeCapabilities> {
    const v = object(await this.client._request("GET", `${prefix}/capabilities${query(params)}`, options));
    if (v.stage !== "inactive" || v.execution_available !== false || v.billing_available !== false) return invalid();
    return { stage: "inactive", execution_available: false, billing_available: false };
  }
}
