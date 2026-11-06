import { APIConnectionError, APIError, APIResponseValidationError } from "./error.js";
import type { GenerationSessionEvent } from "./types/generation.js";

/** A single-use WebRTC signaling stream. Closing it releases the server session. */
export class GenerationSessionStream implements AsyncIterable<GenerationSessionEvent> {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private consumed = false;
  private closed = false;
  private requestID?: string;
  constructor(response: Response, readonly sessionId: string, private cleanup: () => void, private checkAbort: () => void) {
    if (!response.body) throw new APIResponseValidationError("Session stream has no body");
    this.reader = response.body.getReader();
    this.requestID = response.headers.get("x-request-id") ?? undefined;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<GenerationSessionEvent> {
    if (this.consumed) throw new Error("This stream has already been consumed");
    this.consumed = true;
    const decoder = new TextDecoder();
    let buffer = "", event = "", data: string[] = [], size = 0, answered = false;
    try {
      while (!this.closed) {
        this.checkAbort();
        const next = await this.reader.read();
        buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
        if (buffer.length + size > 2_097_152) throw new APIResponseValidationError("Session event exceeds the size limit");
        let match: RegExpExecArray | null;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          if (!next.done && match[0] === "\r" && match.index === buffer.length - 1) break;
          const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
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
            const part = line.slice(5).replace(/^ /, ""); data.push(part); size += part.length;
          } else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
        }
        if (next.done && !this.closed) throw new APIResponseValidationError("Session stream ended unexpectedly; retrieve session status and billing");
      }
    } catch (error) {
      this.checkAbort();
      if (error instanceof TypeError) throw new APIConnectionError("Session streaming connection was interrupted", { cause: error });
      throw error;
    } finally { await this.close(); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.reader.cancel(); } catch { /* Keep the original error. */ }
    finally { this.reader.releaseLock(); this.cleanup(); }
  }
  async abort(): Promise<void> { await this.close(); }
}
