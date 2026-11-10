import WebSocket, { type RawData } from "ws";
import type { GenerationSession, GenerationSessionConnection } from "./types/generation.js";

const MAX_BYTES = 16 * 1024 * 1024;
export type GenerationSocketMessage = string | Uint8Array;
export interface GenerationSocketOptions {
  signal?: AbortSignal;
  /** Explicit trust for a separately configured QCloud relay; never a provider URL. */
  relayOrigin?: string;
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
  sendTimeoutMs?: number;
  maxDurationMs?: number;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
  maxBufferedMessages?: number;
}
export class GenerationSocketError extends Error {
  closeError?: GenerationSocketError;
  constructor(readonly code: string, readonly sessionId: string) {
    super(`Generation socket: ${code.replaceAll("_", " ")}`);
    this.name = "GenerationSocketError";
  }
}
interface Limits {
  openTimeoutMs: number; closeTimeoutMs: number; sendTimeoutMs: number; maxDurationMs: number;
  maxMessageBytes: number; maxBufferedBytes: number; maxBufferedMessages: number;
}
function limits(options: GenerationSocketOptions): Limits {
  const result = { openTimeoutMs: options.openTimeoutMs ?? 10_000, closeTimeoutMs: options.closeTimeoutMs ?? 5_000,
    sendTimeoutMs: options.sendTimeoutMs ?? 10_000, maxDurationMs: options.maxDurationMs ?? 3_600_000,
    maxMessageBytes: options.maxMessageBytes ?? MAX_BYTES, maxBufferedBytes: options.maxBufferedBytes ?? MAX_BYTES,
    maxBufferedMessages: options.maxBufferedMessages ?? 16 };
  const maxima = { openTimeoutMs: 20_000, closeTimeoutMs: 10_000, sendTimeoutMs: 20_000,
    maxDurationMs: 3_600_000, maxMessageBytes: MAX_BYTES, maxBufferedBytes: MAX_BYTES, maxBufferedMessages: 16 };
  for (const name of Object.keys(result) as (keyof Limits)[])
    if (!Number.isSafeInteger(result[name]) || result[name] < 1 || result[name] > maxima[name]) throw new TypeError(`Invalid ${name}`);
  return result;
}
function secureOrigin(raw: string): URL {
  if (typeof raw !== "string" || /[\s\\?#\x00-\x1f\x7f]/.test(raw)) throw new TypeError("Invalid QCloud relay URL");
  const value = new URL(raw);
  const rawHost = /^ws:\/\/(\[[^\]]+\]|[^/:]+)(?::[0-9]+)?(?:\/|$)/.exec(raw)?.[1];
  if (value.username || value.password || value.search || value.hash || !["ws:", "wss:"].includes(value.protocol)
    || (value.protocol === "ws:" && !["127.0.0.1", "[::1]"].includes(rawHost ?? ""))) throw new TypeError("A secure QCloud relay origin is required");
  return value;
}
/** Validate the capability before constructing a socket; never forward API headers. */
export function validateGenerationSocketCapability(value: GenerationSessionConnection, id: string, baseURL: string, relayOrigin?: string) {
  const fail = () => new GenerationSocketError("invalid_capability", id);
  try {
    if (value.transport !== "websocket" || value.session_id !== id || (value.signaling !== undefined && value.signaling !== "websocket")) throw fail();
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.token) || Buffer.from(value.token, "base64url").toString("base64url") !== value.token) throw fail();
    if (value.subprotocols.length !== 2 || value.subprotocols[0] !== "qcloud.realtime.v1" || value.subprotocols[1] !== `qcloud.cap.${value.token}`
      || !["json", "msgpack"].includes(value.encoding)) throw fail();
    // PostgreSQL emits either UTC offsets or Z, with up to six fractional digits.
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value.expires_at);
    const expiry = Date.parse(value.expires_at);
    if (!match || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 60_000) throw fail();
    const localDate = new Date(`${match[1]}T${match[2]}Z`);
    if (!Number.isFinite(localDate.getTime()) || localDate.toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`) throw fail();
    const base = new URL(baseURL), expected = secureOrigin(relayOrigin ?? `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}`);
    if (expected.pathname !== "/") throw fail();
    const url = secureOrigin(value.websocket_url), suffix = `/generation/sessions/${id}/socket`;
    const paths = new Set([`/v1${suffix}`, `${base.pathname.replace(/\/$/, "")}${suffix}`]);
    if (url.href !== value.websocket_url || url.origin !== expected.origin || !paths.has(url.pathname)) throw fail();
    return { url: url.href, protocols: [...value.subprotocols], encoding: value.encoding };
  } catch { throw fail(); }
}

/** Owns one native WebSocket. Text and binary messages are not decoded or rewritten. */
export class GenerationSocket implements AsyncIterableIterator<GenerationSocketMessage> {
  readonly closed: Promise<void>;
  closeResult?: GenerationSession;
  closeError?: GenerationSocketError;
  private socket: WebSocket;
  private ready: Promise<void>;
  private transportClosed: Promise<void>;
  private finishPromise?: Promise<void>;
  private terminalError?: GenerationSocketError;
  private ended = false;
  private opened = false;
  private pendingSend = false;
  private queue: { value: GenerationSocketMessage; bytes: number }[] = [];
  private queuedBytes = 0;
  private waiter?: { resolve: (value: IteratorResult<GenerationSocketMessage>) => void; reject: (error: unknown) => void };
  private resolveClosed!: () => void;
  private rejectClosed!: (error: unknown) => void;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private abort: () => void;

  private constructor(readonly sessionId: string, readonly encoding: "json" | "msgpack", url: string, protocols: string[],
    private bounds: Limits, private closeSession: () => Promise<GenerationSession>, private signal?: AbortSignal) {
    this.closed = new Promise((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
    // Explicit close/iteration still receives failures; idle users do not cause an unhandled rejection.
    void this.closed.catch(() => {});
    this.socket = new WebSocket(url, protocols, { followRedirects: false, handshakeTimeout: bounds.openTimeoutMs,
      maxPayload: bounds.maxMessageBytes, perMessageDeflate: false });
    this.transportClosed = new Promise(resolve => this.socket.once("close", () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", () => {
        if (this.ended || this.socket.protocol !== "qcloud.realtime.v1") {
          const error = new GenerationSocketError("unexpected_subprotocol", sessionId); reject(error); void this.finish(error); return;
        }
        this.opened = true;
        this.durationTimer = setTimeout(() => void this.finish(new GenerationSocketError("duration_exceeded", sessionId)), bounds.maxDurationMs);
        this.durationTimer.unref(); resolve();
      });
      this.socket.on("error", () => {
        const error = new GenerationSocketError(this.opened ? "transport_failed" : "handshake_failed", sessionId);
        reject(error); void this.finish(error);
      });
      this.socket.on("unexpected-response", (_request, response) => {
        response.destroy();
        const error = new GenerationSocketError("handshake_rejected", sessionId); reject(error); void this.finish(error);
      });
      this.socket.on("close", code => {
        const error = !this.opened ? new GenerationSocketError("handshake_failed", sessionId)
          : code !== 1000 && code !== 1001 ? new GenerationSocketError("transport_closed", sessionId) : undefined;
        if (error) reject(error);
        void this.finish(error, false);
      });
    });
    this.socket.on("message", (raw: RawData, binary: boolean) => {
      if (this.ended) return;
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
      if (bytes.length > bounds.maxMessageBytes) { void this.finish(new GenerationSocketError("message_too_large", sessionId)); return; }
      const value = binary ? new Uint8Array(bytes) : bytes.toString("utf8");
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ value, done: false }); return; }
      if (this.queue.length >= bounds.maxBufferedMessages || this.queuedBytes + bytes.length > bounds.maxBufferedBytes) {
        void this.finish(new GenerationSocketError("receive_buffer_exceeded", sessionId)); return;
      }
      this.queue.push({ value, bytes: bytes.length }); this.queuedBytes += bytes.length;
    });
    this.abort = () => void this.finish(new GenerationSocketError("aborted", sessionId));
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  /** @internal */
  static async open(id: string, baseURL: string, options: GenerationSocketOptions,
    capability: (timeoutMs: number) => Promise<GenerationSessionConnection>, closeSession: (timeoutMs: number) => Promise<GenerationSession>): Promise<GenerationSocket> {
    const bounds = limits(options); options.signal?.throwIfAborted();
    if (options.relayOrigin !== undefined && secureOrigin(options.relayOrigin).pathname !== "/") throw new TypeError("relayOrigin must be a bare origin");
    let closePromise: Promise<GenerationSession> | undefined;
    const close = () => closePromise ??= closeSession(bounds.closeTimeoutMs);
    let socket: GenerationSocket | undefined;
    // Failed capability HTTP requests retain the SDK's status/error. An unused
    // capability expires without opening provider work; never retry its POST.
    const value = await capability(bounds.openTimeoutMs);
    try {
      options.signal?.throwIfAborted();
      const target = validateGenerationSocketCapability(value, id, baseURL, options.relayOrigin);
      socket = new GenerationSocket(id, target.encoding, target.url, target.protocols, bounds, close, options.signal);
      await socket.ready;
      if (socket.ended) { await socket.closed; throw new GenerationSocketError("closed_before_open", id); }
      return socket;
    } catch (error) {
      const failure = options.signal?.aborted ? new GenerationSocketError("aborted", id)
        : error instanceof GenerationSocketError ? error : new GenerationSocketError("capability_request_failed", id);
      if (socket) { await socket.finish(failure); failure.closeError = socket.closeError; }
      else try { await close(); } catch { failure.closeError = new GenerationSocketError("session_close_unconfirmed", id); }
      throw failure;
    }
  }

  private async waitForTransportClose(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.transportClosed, new Promise<void>(resolve => {
      timer = setTimeout(() => { this.socket.terminate(); resolve(); }, this.bounds.closeTimeoutMs);
    })]);
    clearTimeout(timer);
  }
  private finish(error?: GenerationSocketError, discard = true): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.ended = true; this.terminalError = error;
    clearTimeout(this.durationTimer); this.signal?.removeEventListener("abort", this.abort);
    if (discard || error) { this.queue = []; this.queuedBytes = 0; }
    // Defer teardown so close/error events cannot recurse before the shared promise exists.
    this.finishPromise = Promise.resolve().then(async () => {
      if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
      else if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000);
      await this.waitForTransportClose();
      try { this.closeResult = await this.closeSession(); }
      catch {
        this.closeError = new GenerationSocketError("session_close_unconfirmed", this.sessionId);
        if (this.terminalError) this.terminalError.closeError = this.closeError; else this.terminalError = this.closeError;
      }
      if (this.terminalError) this.rejectClosed(this.terminalError); else this.resolveClosed();
      if (this.waiter) {
        const waiter = this.waiter; this.waiter = undefined;
        if (this.terminalError) waiter.reject(this.terminalError); else waiter.resolve({ value: undefined, done: true });
      }
    });
    return this.finishPromise;
  }
  async send(value: GenerationSocketMessage): Promise<void> {
    if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new TypeError("Send a string or Uint8Array; encode model messages explicitly");
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) throw this.terminalError ?? new GenerationSocketError("socket_closed", this.sessionId);
    const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    if (bytes > this.bounds.maxMessageBytes || bytes + this.socket.bufferedAmount > this.bounds.maxBufferedBytes) throw new GenerationSocketError("send_buffer_exceeded", this.sessionId);
    if (this.pendingSend) throw new GenerationSocketError("concurrent_send", this.sessionId);
    this.pendingSend = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new GenerationSocketError("send_timeout", this.sessionId)), this.bounds.sendTimeoutMs);
        this.socket.send(value, { binary: typeof value !== "string" }, error => { clearTimeout(timer); error ? reject(new GenerationSocketError("send_failed", this.sessionId)) : resolve(); });
      });
    } catch (error) { const failure = error instanceof GenerationSocketError ? error : new GenerationSocketError("send_failed", this.sessionId); await this.finish(failure); throw failure; }
    finally { this.pendingSend = false; }
  }
  async next(): Promise<IteratorResult<GenerationSocketMessage>> {
    if (this.waiter) throw new GenerationSocketError("concurrent_receive", this.sessionId);
    if (this.queue.length) { const item = this.queue.shift()!; this.queuedBytes -= item.bytes; return { value: item.value, done: false }; }
    if (this.ended) { await this.closed; return { value: undefined, done: true }; }
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<GenerationSocketMessage> { return this; }
  async return(): Promise<IteratorResult<GenerationSocketMessage>> { await this.close(); return { value: undefined, done: true }; }
  async close(): Promise<void> { this.queue = []; this.queuedBytes = 0; await this.finish(); await this.closed; }
}
