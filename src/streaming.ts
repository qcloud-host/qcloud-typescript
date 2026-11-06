import { APIConnectionError, APIError, APIResponseValidationError } from "./error.js";
/** A single-use SSE stream. Breaking iteration cancels the HTTP body. */
export class Stream<T> implements AsyncIterable<T> {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private consumed = false;
  private closed = false;
  private requestID?: string;
  constructor(
    response: Response,
    private cleanup: () => void = () => {},
    private checkAbort: () => void = () => {},
  ) {
    if (!response.body)
      throw new APIResponseValidationError("Streaming response has no body");
    this.reader = response.body.getReader();
    this.requestID = response.headers.get("x-request-id") ?? undefined;
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
        const error = (value as { error: { message?: string } }).error;
        const streamError = new APIError(
          200,
          error?.message ?? "The API reported a streaming error",
          { body: value },
        );
        streamError.requestID = this.requestID;
        throw streamError;
      }
      return value as T;
    };
    try {
      while (!this.closed) {
        this.checkAbort();
        const { value, done } = await this.reader.read();
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        if (done) buffer += "\n\n";
        let match: RegExpExecArray | null;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          if (!done && match[0] === "\r" && match.index === buffer.length - 1)
            break;
          const line = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (line === "") {
            if (data.length) {
              const payload = data.join("\n");
              data = [];
              if (payload.trim() === "[DONE]") return;
              yield parse(payload);
            }
          } else if (line === "data" || line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (done && !this.closed)
          throw new APIResponseValidationError("The SSE response ended before [DONE]");
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
