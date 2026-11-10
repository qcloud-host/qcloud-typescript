import { Chat } from "./resources/chat.js";
import { Completions } from "./resources/completions.js";
import { Embeddings } from "./resources/embeddings.js";
import { Models } from "./resources/models.js";
import { Generation } from "./resources/generation.js";
import { Serverless } from "./resources/serverless.js";
import { Messages } from "./resources/messages.js";
import {
  APIConnectionError,
  APITimeoutError,
  APIResponseValidationError,
  parseRetryAfter,
  raiseForStatus,
} from "./error.js";
import { Stream } from "./streaming.js";
import { GenerationSessionStream } from "./session-stream.js";
import { GenerationFile, downloadError } from "./download.js";
import { uploadFile, type GenerationUploadOptions, type GenerationUploadSource } from "./upload.js";

export const SDK_VERSION = "0.4.0";
export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
}
export interface ClientOptions {
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  timeout?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}
function retryDelay(response: Response | undefined, attempt: number): number {
  const seconds = parseRetryAfter(response?.headers.get("retry-after"));
  return seconds !== undefined && seconds <= 60
    ? seconds * 1000
    : Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.25);
}
/** 429 is an admission rejection before provider dispatch; other statuses are retried only for reads. */
function retryableStatus(method: string, status: number): boolean {
  return status === 429 || (method === "GET" && ([408, 409].includes(status) || status >= 500));
}
// Socket errors raised while connecting: the request bytes were never written,
// so nothing can have been admitted or billed and every method may retry. A
// reset or close on an established (possibly reused) connection is ambiguous
// for POST and is never replayed.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ENETUNREACH", "EHOSTUNREACH"]);
function failedBeforeSend(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = (error as { cause?: unknown }).cause as { code?: unknown; errors?: unknown } | undefined;
  if (!cause || typeof cause !== "object") return false;
  if (typeof cause.code === "string" && NOT_SENT_CODES.has(cause.code)) return true;
  return Array.isArray(cause.errors) && cause.errors.length > 0 &&
    cause.errors.every((item) => typeof item?.code === "string" && NOT_SENT_CODES.has(item.code));
}
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
export class QCloudAI {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly organization?: string;
  readonly chat: Chat;
  readonly completions: Completions;
  readonly embeddings: Embeddings;
  readonly models: Models;
  readonly generation: Generation;
  readonly serverless: Serverless;
  /** Supported subset of the Anthropic Messages API. */
  readonly messages: Messages;
  private _defaultHeaders: Record<string, string>;
  private _fetch: typeof globalThis.fetch;
  constructor(opts: ClientOptions = {}) {
    if (
      typeof window !== "undefined" &&
      typeof window.document !== "undefined"
    ) {
      throw new Error(
        "QCloud API keys must stay on your server. Browser execution is disabled.",
      );
    }
    this.apiKey = opts.apiKey ?? process.env.QCLOUD_API_KEY ?? "";
    if (!this.apiKey)
      throw new Error(
        "No API key provided. Pass apiKey or set QCLOUD_API_KEY.",
      );
    this.baseURL = (
      opts.baseURL ??
      process.env.QCLOUD_BASE_URL ??
      "https://platform.qcloud.host/api/v1"
    ).replace(/\/+$/, "");
    const url = new URL(this.baseURL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "baseURL must be an HTTP(S) URL without credentials, query, or fragment",
      );
    }
    this.timeout = opts.timeout ?? 600_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.organization = opts.organization ?? process.env.QCLOUD_ORGANIZATION_ID;
    if (this.organization && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.organization))
      throw new Error("organization must be an organization UUID");
    if (!Number.isFinite(this.timeout) || this.timeout <= 0)
      throw new Error("timeout must be positive");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0)
      throw new Error("maxRetries must be a non-negative integer");
    this._defaultHeaders = opts.defaultHeaders ?? {};
    this._fetch = opts.fetch ?? globalThis.fetch;
    this.chat = new Chat(this);
    this.completions = new Completions(this);
    this.embeddings = new Embeddings(this);
    this.models = new Models(this);
    this.generation = new Generation(this);
    this.serverless = new Serverless(this);
    this.messages = new Messages(this);
  }
  /** @internal */
  _buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": `qcloud-ai-node/${SDK_VERSION}`,
      ...(this.organization ? { "X-QCloud-Organization": this.organization } : {}),
      ...this._defaultHeaders,
    };
  }
  /** @internal Upload transport is separate from JSON and streaming downloads. */
  _upload(source: GenerationUploadSource, options?: GenerationUploadOptions) {
    return uploadFile({ baseURL: this.baseURL, headers: this._buildHeaders(), fetch: this._fetch }, source, options);
  }
  /** @internal */
  async _request<T>(
    method: string,
    path: string,
    opts?: RequestOptions & { body?: unknown; stream?: boolean; terminal?: (event: any) => boolean; sessionId?: string; binary?: { jobId: string; assetId: string; maxBytes: number } },
  ): Promise<T> {
    const body =
      opts?.body === undefined ? undefined : JSON.stringify(opts.body);
    const timeout = opts?.timeout ?? this.timeout;
    const maxRetries = opts?.maxRetries ?? this.maxRetries;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeout must be positive");
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative integer");
    for (let attempt = 0; ; attempt++) {
      opts?.signal?.throwIfAborted();
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
      const abort = () => controller.abort(opts?.signal?.reason);
      opts?.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", abort);
      };
      let streamOwnsCleanup = false;
      let response: Response | undefined;
      try {
        response = await this._fetch(`${this.baseURL}${path}`, {
          method,
          body,
          headers: { ...this._buildHeaders(), ...opts?.headers },
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          if (opts?.binary) await downloadError(response, controller.signal);
          if (attempt < maxRetries && retryableStatus(method, response.status)) {
            await response.body?.cancel();
            cleanup();
            await sleep(retryDelay(response, attempt), opts?.signal);
            continue;
          }
          const raw = await response.text();
          let data: unknown;
          try {
            data = JSON.parse(raw);
          } catch {
            data = {
              error: { message: raw.slice(0, 500) || response.statusText },
            };
          }
          raiseForStatus(response.status, data, response.headers);
        }
        if (opts?.binary) {
          const checkAbort = () => {
            if (opts?.signal?.aborted) throw opts.signal.reason;
            if (timedOut) throw new APITimeoutError();
          };
          try {
            const download = new GenerationFile(response, opts.binary.jobId, opts.binary.assetId, opts.binary.maxBytes, cleanup, checkAbort, controller.signal);
            streamOwnsCleanup = true;
            return download as T;
          } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
        }
        if (opts?.stream) {
          if (
            !response.headers.get("content-type")?.includes("text/event-stream")
          ) {
            await response.body?.cancel();
            throw new APIResponseValidationError(
              "Expected an SSE response from the streaming endpoint",
            );
          }
          const checkAbort = () => {
            if (opts?.signal?.aborted) throw opts.signal.reason;
            if (timedOut) throw new APITimeoutError();
          };
          const stream = opts.sessionId ? new GenerationSessionStream(response, opts.sessionId, cleanup, checkAbort, controller.signal) : new Stream<unknown>(response, cleanup, checkAbort, controller.signal, opts.terminal);
          streamOwnsCleanup = true;
          return stream as T;
        }
        const raw = await response.text();
        try {
          return JSON.parse(raw) as T;
        } catch {
          throw new APIResponseValidationError("The API returned invalid JSON");
        }
      } catch (err) {
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (timedOut || err instanceof TypeError) {
          // A failed POST may already have generated billable output. Only a
          // failure before the request was sent is replayed.
          if (attempt < maxRetries && (method === "GET" || (!timedOut && failedBeforeSend(err)))) {
            cleanup();
            await sleep(retryDelay(undefined, attempt), opts?.signal);
            continue;
          }
          if (timedOut) throw new APITimeoutError();
          throw new APIConnectionError("Could not connect to the QCloud API", {
            cause: err instanceof Error ? err : undefined,
          });
        }
        throw err;
      } finally {
        if (!streamOwnsCleanup) cleanup();
      }
    }
  }
}
export default QCloudAI;
