import { APIConnectionError, APIResponseValidationError, raiseForStatus } from "./error.js";

export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** Read only a bounded diagnostic body; an error must not buffer a media file. */
export async function downloadError(response: Response, signal: AbortSignal): Promise<never> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (reader && size < 65536) {
      const next = await reader.read(); if (next.done) break;
      const chunk = next.value.slice(0, 65536 - size); chunks.push(chunk); size += chunk.length;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  const raw = new TextDecoder().decode(bytes); let body: unknown;
  try { body = JSON.parse(raw); } catch { body = { error: { message: raw.slice(0, 500) || response.statusText } }; }
  raiseForStatus(response.status, body, response.headers);
  throw new APIResponseValidationError("Unexpected download status");
}

/** A single-use binary response. Consume with for-await and always close in finally. */
export class GenerationFile implements AsyncIterable<Uint8Array> {
  readonly status: number;
  readonly contentType: string;
  readonly contentLength?: number;
  readonly contentRange?: string;
  readonly acceptRanges?: string;
  readonly requestID?: string;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private consumed = false;
  private closed = false;
  private total = 0;
  private abortListener: () => void;
  private closePromise?: Promise<void>;
  constructor(response: Response, readonly jobId: string, readonly assetId: string, private maxBytes: number,
    private cleanup: () => void, private checkAbort: () => void, private signal: AbortSignal) {
    if (![200, 206].includes(response.status) || !response.body) throw new APIResponseValidationError("Expected a binary download response");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") throw new APIResponseValidationError("Unexpected download content encoding");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new APIResponseValidationError("Invalid download content length");
    this.contentLength = length === null ? undefined : Number(length);
    if (this.contentLength !== undefined && this.contentLength > maxBytes) throw new APIResponseValidationError("Download exceeds maxBytes");
    this.status = response.status; this.contentType = response.headers.get("content-type") ?? "application/octet-stream";
    this.contentRange = response.headers.get("content-range") ?? undefined;
    this.acceptRanges = response.headers.get("accept-ranges") ?? undefined;
    this.requestID = response.headers.get("x-request-id") ?? undefined;
    this.reader = response.body.getReader();
    this.abortListener = () => { void this.close(); };
    signal.addEventListener("abort", this.abortListener, { once: true });
    if (signal.aborted) this.abortListener();
  }
  get bytesRead(): number { return this.total; }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.consumed) throw new Error("This download has already been consumed");
    this.consumed = true;
    try {
      this.checkAbort();
      while (!this.closed) {
        const next = await this.reader.read(); this.checkAbort();
        if (this.closed) return;
        if (next.done) {
          if (this.contentLength !== undefined && this.total !== this.contentLength) throw new APIResponseValidationError("Download ended before the declared content length");
          return;
        }
        this.total += next.value.length;
        if (this.total > this.maxBytes) throw new APIResponseValidationError("Download exceeds maxBytes");
        if (this.contentLength !== undefined && this.total > this.contentLength) throw new APIResponseValidationError("Download exceeds its declared content length");
        for (let offset = 0; offset < next.value.length; offset += 65536) {
          this.checkAbort(); if (this.closed) return;
          yield next.value.subarray(offset, offset + 65536);
        }
      }
      this.checkAbort();
    } catch (error) {
      this.checkAbort();
      if (error instanceof TypeError) throw new APIConnectionError("Download connection was interrupted", { cause: error });
      throw error;
    } finally { await this.close(); }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.signal.removeEventListener("abort", this.abortListener); this.cleanup();
    this.closePromise = this.reader.cancel().catch(() => {}).finally(() => { this.reader.releaseLock(); });
    return this.closePromise;
  }
  abort(): Promise<void> { return this.close(); }
}
