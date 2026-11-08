import { randomUUID } from "node:crypto";
import type { QCloudAI, RequestOptions } from "../client.js";
import { APIResponseValidationError, APITimeoutError, QCloudAIError } from "../error.js";
import type { GenerationJob, GenerationJobStatus, GenerationModel, GenerationModelList, GenerationModelListParams, GenerationPendingResult, GenerationResult, GenerationSchema, GenerationSubmitParams, GenerationSubscription, JSONValue } from "../types/generation.js";
import { GenerationSessions } from "./generation-sessions.js";
import { normalizeUuid } from "../uuid.js";

const statuses = new Set<GenerationJobStatus>(["queued", "submitting", "running", "succeeded", "failed", "cancelled", "review"]);
function pathId(value: string): string {
  if (typeof value !== "string" || !value) throw new TypeError("An ID is required");
  return encodeURIComponent(value);
}
function job(value: unknown): GenerationJob {
  const data = value as GenerationJob;
  if (!data || typeof data.id !== "string" || typeof data.model !== "string" || !statuses.has(data.status) || !data.billing) throw new APIResponseValidationError("The API returned an invalid generation job");
  return data;
}
function jobEnvelope(value: unknown, expectedId?: string): GenerationJob {
  if (!value || typeof value !== "object" || !("data" in value)) throw new APIResponseValidationError("The API returned an invalid generation job envelope");
  const current = job(value.data);
  if (expectedId !== undefined && current.id !== expectedId) throw new APIResponseValidationError("The API returned a different generation job");
  return current;
}
function assertJSON(value: unknown, seen = new Set<object>()): asserts value is JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError("input must contain only JSON values");
  seen.add(value);
  for (const child of Object.values(value)) assertJSON(child, seen);
  seen.delete(value);
}
export class GenerationJobError extends QCloudAIError {
  constructor(readonly job: GenerationJob) { super(job.error?.message ?? `Generation job ${job.status}`); this.name = "GenerationJobError"; }
}
export class GenerationTimeoutError extends APITimeoutError {
  constructor(readonly jobId?: string, readonly clientRequestId?: string) { super("Generation polling timed out; the job may still be running"); this.name = "GenerationTimeoutError"; }
}
export interface GenerationPollOptions extends RequestOptions {
  /** Overall wait deadline in milliseconds; default ten minutes. */
  timeoutMs?: number;
  /** Delay between status checks in milliseconds; default one second. */
  pollIntervalMs?: number;
  onUpdate?: (job: GenerationJob) => void;
}
function pollOptions(options: GenerationPollOptions) {
  const timeout = options.timeoutMs ?? 600_000, interval = options.pollIntervalMs ?? 1_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new TypeError("timeoutMs must be positive and no greater than 2147483647");
  if (!Number.isFinite(interval) || interval <= 0 || interval > 60_000) throw new TypeError("pollIntervalMs must be positive and no greater than 60000");
  return { timeout, interval };
}
async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class GenerationModels {
  constructor(private client: QCloudAI) {}
  list(params: GenerationModelListParams = {}, options?: RequestOptions): Promise<GenerationModelList> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    return this.client._request("GET", `/generation/models${query.size ? `?${query}` : ""}`, options);
  }
  retrieve(id: string, options?: RequestOptions): Promise<GenerationModel> { return this.client._request("GET", `/generation/models/${pathId(id)}`, options); }
  schema(id: string, options?: RequestOptions): Promise<GenerationSchema> { return this.client._request("GET", `/generation/models/${pathId(id)}/schema`, options); }
}
export class GenerationJobs {
  constructor(private client: QCloudAI) {}
  async submit(params: GenerationSubmitParams, options?: RequestOptions): Promise<GenerationJob> {
    if (params.billing_mode !== "metered") throw new TypeError("billing_mode:'metered' is required to accept variable usage charges");
    pathId(params.model); assertJSON(params.input);
    const requestId = normalizeUuid(params.client_request_id ?? randomUUID(), "client_request_id");
    if (params.timeout_seconds !== undefined && (!Number.isInteger(params.timeout_seconds) || params.timeout_seconds < 1 || params.timeout_seconds > 86400)) throw new TypeError("timeout_seconds must be an integer from 1 to 86400");
    const body = { model: params.model, input: params.input, billing_mode: "metered", client_request_id: requestId, ...(params.timeout_seconds === undefined ? {} : { timeout_seconds: params.timeout_seconds }) };
    try { return jobEnvelope(await this.client._request("POST", "/generation/jobs", { ...options, maxRetries: 0, body })); }
    catch (error) {
      // Preserve typed API errors and attach the identity required for an explicit retry.
      if (error instanceof QCloudAIError) Object.assign(error, { clientRequestId: requestId });
      throw error;
    }
  }
  async retrieve(id: string, options?: RequestOptions): Promise<GenerationJob> { id = normalizeUuid(id, "job ID"); return jobEnvelope(await this.client._request("GET", `/generation/jobs/${id}`, options), id); }
  async cancel(id: string, options?: RequestOptions): Promise<GenerationJob> { id = normalizeUuid(id, "job ID"); return jobEnvelope(await this.client._request("POST", `/generation/jobs/${id}/cancel`, { ...options, maxRetries: 0 }), id); }
  async result<T = JSONValue>(id: string, options?: RequestOptions): Promise<GenerationResult<T> | GenerationPendingResult> {
    id = normalizeUuid(id, "job ID");
    const value = await this.client._request<GenerationResult<T> | GenerationPendingResult>("GET", `/generation/jobs/${id}/result`, { ...options, maxRetries: options?.maxRetries ?? 0 });
    if (!value || typeof value !== "object" || !("data" in value)) throw new APIResponseValidationError("The API returned an invalid generation result");
    if ("job_id" in value) { if (value.job_id !== id || !value.billing) throw new APIResponseValidationError("The generation result belongs to a different job"); }
    else if (job(value.data).id !== id) throw new APIResponseValidationError("The API returned a different generation job");
    return value;
  }
  private async poll(id: string, options: GenerationPollOptions, signal: AbortSignal, interval: number): Promise<GenerationJob> {
    for (;;) {
      signal.throwIfAborted();
      const current = await this.retrieve(id, { ...options, signal, maxRetries: 0 });
      if (current.id !== id) throw new APIResponseValidationError("The API returned a different generation job");
      options.onUpdate?.(current);
      if (["failed", "cancelled", "review"].includes(current.status)) throw new GenerationJobError(current);
      if (current.status === "succeeded") return current;
      await delay(interval, signal);
    }
  }
  async wait(id: string, options: GenerationPollOptions = {}): Promise<GenerationJob> {
    id = normalizeUuid(id, "job ID"); const { timeout, interval } = pollOptions(options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new GenerationTimeoutError(id)), timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try { return await this.poll(id, options, signal, interval); } finally { clearTimeout(timer); }
  }
  async subscribe<T = JSONValue>(params: GenerationSubmitParams, options: GenerationPollOptions = {}): Promise<GenerationSubscription<T>> {
    const { timeout, interval } = pollOptions(options), requestId = normalizeUuid(params.client_request_id ?? randomUUID(), "client_request_id");
    let jobId: string | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new GenerationTimeoutError(jobId, requestId)), timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      const submitted = await this.submit({ ...params, client_request_id: requestId }, { ...options, signal }); jobId = submitted.id;
      for (;;) {
        const completed = await this.poll(jobId, options, signal, interval);
        const output = await this.result<T>(jobId, { ...options, signal, maxRetries: 0 });
        if ("job_id" in output) return { job: completed, result: output };
        await delay(interval, signal);
      }
    } finally { clearTimeout(timer); }
  }
}
export class Generation {
  readonly models: GenerationModels;
  readonly jobs: GenerationJobs;
  readonly sessions: GenerationSessions;
  constructor(client: QCloudAI) { this.models = new GenerationModels(client); this.jobs = new GenerationJobs(client); this.sessions = new GenerationSessions(client); }
}
