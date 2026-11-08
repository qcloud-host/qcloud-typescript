import { APIConnectionError, APIError, APIResponseValidationError } from "./error.js";
import type { GenerationSessionEvent } from "./types/generation.js";
import { bindStreamAbort } from "./stream-abort.js";

const MAX_EVENT_BYTES = 2_097_152;

/** Frame incrementally before parsing SSE; a missing newline must not grow the
 * parser without limit. A transport-supplied chunk is never copied in full. */
async function* sessionLines(reader: ReadableStreamDefaultReader<Uint8Array>, checkAbort: () => void, isClosed: () => boolean): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const decode = (bytes?: Uint8Array, stream = false): string => {
    try { return decoder.decode(bytes, { stream }); }
    catch { throw new APIResponseValidationError("Invalid UTF-8 in session stream"); }
  };
  while (!isClosed()) {
    checkAbort();
    const next = await reader.read();
    checkAbort();
    if (isClosed()) return;
    const bytes = next.value ?? new Uint8Array();
    for (let offset = 0; offset < bytes.byteLength || (next.done && offset === 0); offset += 65_536) {
      checkAbort();
      if (isClosed()) return;
      buffer += next.done ? decode() : decode(bytes.subarray(offset, offset + 65_536), true);
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        checkAbort();
        if (isClosed()) return;
        if (!next.done && match[0] === "\r" && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new APIResponseValidationError("Session event exceeds the size limit");
        buffer = buffer.slice(match.index + match[0].length);
        yield line;
      }
      if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES + (buffer.endsWith("\r") ? 1 : 0)) throw new APIResponseValidationError("Session event exceeds the size limit");
    }
    if (next.done) {
      checkAbort();
      if (!isClosed() && buffer) yield buffer;
      return;
    }
  }
}

/** A single-use WebRTC signaling stream. Closing it releases the server session. */
export class GenerationSessionStream implements AsyncIterable<GenerationSessionEvent> {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private consumed = false;
  private closed = false;
  private requestID?: string;
  private unbindAbort: () => void;
  constructor(response: Response, readonly sessionId: string, private cleanup: () => void, private checkAbort: () => void, signal?: AbortSignal) {
    if (!response.body) throw new APIResponseValidationError("Session stream has no body");
    this.reader = response.body.getReader();
    this.requestID = response.headers.get("x-request-id") ?? undefined;
    this.unbindAbort = bindStreamAbort(this.reader, signal);
  }
  async *[Symbol.asyncIterator](): AsyncIterator<GenerationSessionEvent> {
    if (this.consumed) throw new Error("This stream has already been consumed");
    this.consumed = true;
    let event = "", data: string[] = [], size = 0, answered = false;
    try {
      for await (const line of sessionLines(this.reader, this.checkAbort, () => this.closed)) {
        this.checkAbort();
        if (this.closed) return;
        if (line === "") {
          if (!data.length) { event = ""; continue; }
          let value: unknown;
          try { value = JSON.parse(data.join("\n")); } catch { throw new APIResponseValidationError("Invalid JSON in session event"); }
          const name = event; event = ""; data = []; size = 0;
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new APIResponseValidationError("Invalid session event");
          const object = value as Record<string, unknown>;
          if (name === "error") {
            const info = object.error as { code?: string; message?: string } | undefined;
            const error = new APIError(200, info?.message ?? "Session connection failed", { errorType: info?.code, body: object });
            error.requestID = this.requestID; throw error;
          }
          if (object.session_id !== this.sessionId) throw new APIResponseValidationError("Session event belongs to a different session");
          if (name === "answer") {
            if (answered || object.type !== "answer" || typeof object.sdp !== "string" || !object.sdp) throw new APIResponseValidationError("Invalid or duplicate session answer");
            answered = true;
            yield { event: "answer", data: { session_id: this.sessionId, type: "answer", sdp: object.sdp } };
          } else if (name === "closed" && typeof object.reason === "string") {
            yield { event: "closed", data: { session_id: this.sessionId, reason: object.reason } }; return;
          } else throw new APIResponseValidationError("Unknown session event");
        } else if (line === "data" || line.startsWith("data:")) {
          const part = line.slice(5).replace(/^ /, ""); size += Buffer.byteLength(part) + (data.length ? 1 : 0);
          if (size > MAX_EVENT_BYTES) throw new APIResponseValidationError("Session event exceeds the size limit");
          data.push(part);
        } else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
      }
      this.checkAbort();
      if (!this.closed) throw new APIResponseValidationError("Session stream ended unexpectedly; retrieve session status and billing");
    } catch (error) {
      this.checkAbort();
      if (error instanceof TypeError) throw new APIConnectionError("Session streaming connection was interrupted", { cause: error });
      throw error;
    } finally { await this.close(); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unbindAbort();
    try { await this.reader.cancel(); } catch { /* Keep the original error. */ }
    finally { this.reader.releaseLock(); this.cleanup(); }
  }
  async abort(): Promise<void> { await this.close(); }
}
