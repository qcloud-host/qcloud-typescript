import { APIConnectionError, APIError, APIResponseValidationError, errorDetails } from "./error.js";
import { bindStreamAbort } from "./stream-abort.js";
/** A single-use SSE stream. Breaking iteration cancels the HTTP body. */
export class Stream<T> implements AsyncIterable<T> {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private consumed = false;
  private closed = false;
  private requestID?: string;
  private headers: Headers;
  private unbindAbort: () => void;
  /**
   * `terminal` marks streams that end with a named event (Anthropic Messages
   * `message_stop`) instead of the Chat Completions `[DONE]` sentinel.
   */
  constructor(
    response: Response,
    private cleanup: () => void = () => {},
    private checkAbort: () => void = () => {},
    signal?: AbortSignal,
    private terminal?: (event: T) => boolean,
  ) {
    if (!response.body)
      throw new APIResponseValidationError("Streaming response has no body");
    this.reader = response.body.getReader();
    this.headers = response.headers;
    this.requestID = response.headers.get("x-request-id") ?? undefined;
    this.unbindAbort = bindStreamAbort(this.reader, signal);
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) throw new Error("This stream has already been consumed");
    this.consumed = true;
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    const parse = (payload: string): T => {
      let value: unknown;
      try {
        value = JSON.parse(payload);
      } catch {
        throw new APIResponseValidationError("Invalid JSON in SSE data");
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new APIResponseValidationError("Expected an object in SSE data");
      if ("error" in value) {
        const { message, errorType, code } = errorDetails(value);
        const streamError = new APIError(
          200,
          message ?? "The API reported a streaming error",
          { errorType, code, body: value },
        );
        streamError._attachHeaders(this.headers);
        streamError.requestID ??= this.requestID;
        throw streamError;
      }
      return value as T;
    };
    try {
      while (!this.closed) {
        this.checkAbort();
        const { value, done } = await this.reader.read();
        this.checkAbort();
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        if (done) buffer += "\n\n";
        let match: RegExpExecArray | null;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          // The consumer may cancel or exceed its deadline between two yields
          // from the same network chunk. Do not drain buffered events afterward.
          if (this.closed) return;
          this.checkAbort();
          if (!done && match[0] === "\r" && match.index === buffer.length - 1)
            break;
          const line = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (line === "") {
            if (data.length) {
              const payload = data.join("\n");
              data = [];
              if (payload.trim() === "[DONE]" && !this.terminal) return;
              const event = parse(payload);
              yield event;
              if (this.terminal?.(event)) return;
            }
          } else if (line === "data" || line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (done && !this.closed)
          throw new APIResponseValidationError(
            this.terminal ? "The SSE response ended before its terminal event" : "The SSE response ended before [DONE]",
          );
      }
    } catch (error) {
      this.checkAbort();
      if (error instanceof TypeError)
        throw new APIConnectionError("The streaming connection was interrupted", { cause: error });
      throw error;
    } finally {
      await this.abort();
    }
  }
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unbindAbort();
    try {
      await this.reader.cancel();
    } catch {
      /* Preserve the original read/timeout error during cleanup. */
    } finally {
      this.reader.releaseLock();
      this.cleanup();
    }
  }
}
