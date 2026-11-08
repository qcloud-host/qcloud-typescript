import { randomUUID } from "node:crypto";
import type { QCloudAI, RequestOptions } from "../client.js";
import { APIResponseValidationError, QCloudAIError } from "../error.js";
import { normalizeUuid } from "../uuid.js";
import type { QueueCatalog, QueueDeployment, QueueDeploymentCreateParams, QueueDeploymentList, QueueProfile, QueueRequestParams } from "../types/serverless.js";

const prefix = "/serverless/queue";
const profilePattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const fullMatch = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.exec(value)?.[0] === value;
const validLabel = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length >= 2 && value.length <= 80;
const validName = (value: unknown): value is string => validLabel(value) && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value: unknown, low: number, high: number): value is number => Number.isInteger(value) && Number(value) >= low && Number(value) <= high;
function invalid(): never { throw new APIResponseValidationError("The API returned an invalid queue draft response"); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function responseId(value: unknown): string { try { return normalizeUuid(value as string, "deployment ID"); } catch { return invalid(); } }
function timestamp(value: unknown): value is string { return fullMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/, value) && Number.isFinite(Date.parse(value)); }
function model(value: unknown): value is string { return fullMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, value); }
function deployment(value: unknown, expected?: string): QueueDeployment {
  const v = record(value), id = responseId(v.id);
  if ((expected !== undefined && id !== expected) || !validName(v.name) || v.status !== "draft" || !fullMatch(profilePattern, v.profile_id)
    || !validLabel(v.profile_name) || !model(v.model) || !timestamp(v.created_at) || !timestamp(v.updated_at)) return invalid();
  // Project public fields rather than exposing accidental upstream/private fields.
  return { id, name: v.name, status: "draft", profile_id: v.profile_id, profile_name: v.profile_name, model: v.model, created_at: v.created_at, updated_at: v.updated_at };
}
function profile(value: unknown): QueueProfile {
  const v = record(value), limits = record(v.limits);
  if (!fullMatch(profilePattern, v.id) || !validLabel(v.name) || !model(v.model) || !integer(v.gpu_memory_gb, 8, 192)
    || !integer(v.disk_gb, 10, 512) || v.pricing !== null || limits.max_workers !== 1
    || !integer(limits.idle_timeout_seconds, 1, 3600) || !integer(limits.execution_timeout_seconds, 5, 3600)) return invalid();
  return { id: v.id, name: v.name, model: v.model, gpu_memory_gb: v.gpu_memory_gb, disk_gb: v.disk_gb, pricing: null,
    limits: { max_workers: 1, idle_timeout_seconds: limits.idle_timeout_seconds, execution_timeout_seconds: limits.execution_timeout_seconds } };
}
function query(params: QueueRequestParams): string {
  if (!params || typeof params !== "object" || Object.keys(params).some(key => key !== "org_id")) throw new TypeError("Only org_id is supported");
  return params.org_id === undefined ? "" : `?org_id=${normalizeUuid(params.org_id, "org_id")}`;
}
export class QueueDeployments {
  constructor(private client: QCloudAI) {}
  async create(params: QueueDeploymentCreateParams, options?: RequestOptions): Promise<QueueDeployment> {
    if (!params || typeof params !== "object" || Object.keys(params).some(key => !["name", "profile_id", "org_id", "client_request_id"].includes(key))) throw new TypeError("Unsupported queue draft field");
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!validName(name) || !fullMatch(profilePattern, params.profile_id)) throw new TypeError("A valid name and catalog profile_id are required");
    const requestId = normalizeUuid(params.client_request_id ?? randomUUID(), "client_request_id");
    const body = { name, profile_id: params.profile_id, client_request_id: requestId,
      ...(params.org_id === undefined ? {} : { org_id: normalizeUuid(params.org_id, "org_id") }) };
    try {
      const result = deployment(record(await this.client._request("POST", `${prefix}/deployments`, { ...options, maxRetries: 0, body })).data);
      if (result.name !== name || result.profile_id !== params.profile_id) return invalid();
      return result;
    } catch (error) { if (error instanceof QCloudAIError) error.clientRequestId = requestId; throw error; }
  }
  async list(params: QueueRequestParams = {}, options?: RequestOptions): Promise<QueueDeploymentList> {
    const value = record(await this.client._request("GET", `${prefix}/deployments${query(params)}`, options)).data;
    if (!Array.isArray(value) || value.length > 100) return invalid();
    const data = value.map(v => deployment(v));
    if (new Set(data.map(v => v.id)).size !== data.length) return invalid();
    return { data };
  }
  async retrieve(id: string, params: QueueRequestParams = {}, options?: RequestOptions): Promise<QueueDeployment> {
    id = normalizeUuid(id, "deployment ID");
    return deployment(record(await this.client._request("GET", `${prefix}/deployments/${id}${query(params)}`, options)).data, id);
  }
}
export class ServerlessQueue {
  readonly deployments: QueueDeployments;
  constructor(private client: QCloudAI) { this.deployments = new QueueDeployments(client); }
  async catalog(params: QueueRequestParams = {}, options?: RequestOptions): Promise<QueueCatalog> {
    const v = record(await this.client._request("GET", `${prefix}/catalog${query(params)}`, options));
    if (v.stage !== "draft_preview" || v.runtime_available !== false || !Array.isArray(v.profiles) || v.profiles.length > 16
      || v.creation_available !== (v.profiles.length > 0) || !Array.isArray(v.unsupported) || v.unsupported.length > 32
      || v.unsupported.some(item => typeof item !== "string" || item.length > 80)) return invalid();
    const profiles = v.profiles.map(profile);
    if (new Set(profiles.map(p => p.id)).size !== profiles.length) return invalid();
    return { stage: "draft_preview", runtime_available: false, creation_available: v.creation_available as boolean, profiles, unsupported: [...v.unsupported] as string[] };
  }
}
export class Serverless {
  readonly queue: ServerlessQueue;
  constructor(client: QCloudAI) { this.queue = new ServerlessQueue(client); }
}
