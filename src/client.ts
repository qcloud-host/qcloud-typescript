import { Chat } from "./resources/chat.js";
import { Completions } from "./resources/completions.js";
import { Embeddings } from "./resources/embeddings.js";
import { Models } from "./resources/models.js";
import {
  APIConnectionError,
  APITimeoutError,
  APIResponseValidationError,
  raiseForStatus,
} from "./error.js";
import { Stream } from "./streaming.js";

export const SDK_VERSION = "0.2.0";
export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}
export interface ClientOptions {
  apiKey?: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}
function retryDelay(response: Response | undefined, attempt: number): number {
  const value = response?.headers.get("retry-after");
  const seconds = value ? Number(value) : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : value
      ? Date.parse(value) - Date.now()
      : NaN;
  return Number.isFinite(delay) && delay >= 0 && delay <= 60_000
    ? delay
    : Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.25);
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
  readonly chat: Chat;
  readonly completions: Completions;
  readonly embeddings: Embeddings;
  readonly models: Models;
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
      "https://qcloud.host/api/v1"
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
  }
  /** @internal */
  _buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": `qcloud-ai-node/${SDK_VERSION}`,
      ...this._defaultHeaders,
    };
  }
  /** @internal */
  async _request<T>(
    method: string,
    path: string,
    opts?: RequestOptions & { body?: unknown; stream?: boolean },
  ): Promise<T> {
    const body =
      opts?.body === undefined ? undefined : JSON.stringify(opts.body);
    for (let attempt = 0; ; attempt++) {
      opts?.signal?.throwIfAborted();
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeout);
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
          if (
            attempt < this.maxRetries &&
            ([408, 409, 429].includes(response.status) ||
              response.status >= 500)
          ) {
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
          raiseForStatus(
            response.status,
            data,
            response.headers.get("x-request-id") ?? undefined,
          );
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
          const stream = new Stream<unknown>(response, cleanup, () => {
            if (opts?.signal?.aborted) throw opts.signal.reason;
            if (timedOut) throw new APITimeoutError();
          });
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
        if (timedOut || (err instanceof TypeError && response === undefined)) {
          if (attempt < this.maxRetries) {
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
