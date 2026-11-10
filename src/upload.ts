import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import type { GenerationUploadedFile } from "./types/generation.js";
import { APIConnectionError, APIResponseValidationError, APITimeoutError, raiseForStatus } from "./error.js";
import { normalizeUuid } from "./uuid.js";

export type GenerationUploadSource = Uint8Array | { path: string } | AsyncIterable<Uint8Array>;
export interface GenerationUploadOptions {
  filename?: string;
  contentType?: string;
  /** Optional exact length for a stream; bytes and paths are measured automatically. */
  size?: number;
  maxBytes?: number;
  /** Total request timeout in milliseconds, including source and response delivery. */
  timeout?: number;
  signal?: AbortSignal;
}
const MAX_BYTES = 256 * 1024 * 1024, CHUNK = 65536;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const reserved = new Set(["content-type", "content-length", "transfer-encoding", "content-encoding", "accept-encoding", "expect", "x-qcloud-filename", "x-qcloud-content-type"]);
function filenameValid(value: string): boolean {
  return value !== "." && value !== ".." && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 255 && !/[\p{Cc}/\\]/u.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function positiveSize(value: number, name: string, limit: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new TypeError(`${name} must be an integer from 1 to ${limit}`);
}

/** @internal One authenticated origin-bound request. The source is never replayed. */
export async function uploadFile(
  transport: { baseURL: string; headers: Record<string, string>; fetch: typeof globalThis.fetch },
  source: GenerationUploadSource, options: GenerationUploadOptions = {},
): Promise<GenerationUploadedFile> {
  const maxBytes = options.maxBytes ?? MAX_BYTES, timeout = options.timeout ?? 120_000;
  positiveSize(maxBytes, "maxBytes", MAX_BYTES);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new TypeError("timeout must be positive and at most 2147483647 milliseconds");
  if (options.size !== undefined) positiveSize(options.size, "size", maxBytes);
  const requestedContentType = options.contentType ?? "application/octet-stream";
  const mimeMatch = typeof requestedContentType === "string" ? MIME.exec(requestedContentType) : null;
  if (!mimeMatch || mimeMatch[0].length !== requestedContentType.length || requestedContentType.length > 127) throw new TypeError("contentType must be a bare MIME type of at most 127 characters");
  const contentType = requestedContentType.toLowerCase();
  const isPath = source !== null && typeof source === "object" && "path" in source;
  if (isPath && (typeof source.path !== "string" || !source.path || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source.path))) throw new TypeError("path must be a local file path, not a URL");
  const filename = options.filename ?? (isPath ? basename(source.path) : "upload.bin");
  if (typeof filename !== "string" || !filenameValid(filename)) throw new TypeError("filename must be a UTF-8 basename of at most 255 bytes without control characters");
  options.signal?.throwIfAborted();
  const controller = new AbortController(); let timedOut = false, closed = false;
  let handle: FileHandle | undefined, iterator: AsyncIterator<Uint8Array> | undefined, inputIterator: AsyncIterator<Uint8Array> | undefined;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sourceError: unknown, sent = 0, complete = false, sha256: string | undefined;
  const hash = createHash("sha256");
  const checkAbort = () => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timedOut) throw new APITimeoutError();
  };
  const stopSource = () => {
    if (closed) return;
    closed = true;
    // A caller's iterator must cooperate with return(); never delay HTTP cancellation
    // waiting for an arbitrary user generator that is blocked inside next().
    try { void Promise.resolve(inputIterator?.return?.()).catch(() => {}); } catch { /* cleanup only */ }
    try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* cleanup only */ }
    if (handle) void handle.close().catch(() => {});
  };
  const abort = () => {
    controller.abort(options.signal?.reason);
    try { bodyController?.error(options.signal?.reason ?? new APITimeoutError()); } catch { /* already closed */ }
    stopSource();
  };
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
  options.signal?.addEventListener("abort", abort, { once: true });
  let response: Response | undefined;
  try {
    let size = options.size, input: AsyncIterable<Uint8Array>;
    if (source instanceof Uint8Array) {
      positiveSize(source.byteLength, "source length", maxBytes);
      if (size !== undefined && size !== source.byteLength) throw new TypeError("size does not match source length");
      size = source.byteLength;
      input = (async function* () { yield source; })();
    } else if (isPath) {
      handle = await open(source.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      checkAbort(); const info = await handle.stat();
      if (!info.isFile()) throw new TypeError("path must identify a regular file");
      positiveSize(info.size, "source length", maxBytes);
      if (size !== undefined && size !== info.size) throw new TypeError("size does not match source length");
      size = info.size;
      const file = handle;
      input = (async function* () {
        while (true) {
          checkAbort(); const bytes = new Uint8Array(CHUNK);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
          if (!bytesRead) return;
          yield bytes.subarray(0, bytesRead);
        }
      })();
    } else if (source && typeof source[Symbol.asyncIterator] === "function") input = source;
    else throw new TypeError("source must be bytes, {path}, or an async byte iterable");
    checkAbort();
    inputIterator = input[Symbol.asyncIterator]();
    const bounded = async function* () {
      while (true) {
        checkAbort(); if (closed) return;
        const next = await inputIterator!.next();
        if (next.done) break;
        const bytes = next.value;
        checkAbort(); if (closed) return;
        if (!(bytes instanceof Uint8Array)) throw new TypeError("upload streams must yield Uint8Array chunks");
        if (bytes.byteLength > maxBytes - sent || (size !== undefined && bytes.byteLength > size - sent)) throw new TypeError("Upload exceeds its declared size or maxBytes");
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
          checkAbort(); if (closed) return;
          let chunk = bytes.subarray(offset, offset + CHUNK);
          if (size !== undefined && sent + chunk.byteLength === size) {
            // A Content-Length receiver can reply as soon as it gets the last byte,
            // without pulling our stream again. Verify EOF and finalize the receipt
            // first. Advancing a caller iterator may reuse its buffer, so retain only
            // an owned copy of this final (at most 64 KiB) slice while checking EOF.
            chunk = Uint8Array.from(chunk);
            while (true) {
              checkAbort(); if (closed) return;
              const tail = await inputIterator!.next();
              checkAbort(); if (closed) return;
              if (tail.done) break;
              if (!(tail.value instanceof Uint8Array)) throw new TypeError("upload streams must yield Uint8Array chunks");
              if (tail.value.byteLength) throw new TypeError("Upload exceeds its declared size or maxBytes");
            }
            hash.update(chunk); sent += chunk.byteLength;
            sha256 = hash.digest("hex"); complete = true;
            yield chunk;
            return;
          }
          hash.update(chunk); sent += chunk.byteLength; yield chunk;
        }
      }
      checkAbort();
      if (!sent || (size !== undefined && size !== sent)) throw new TypeError("Upload is empty or does not match its declared size");
      sha256 = hash.digest("hex"); complete = true;
    };
    iterator = bounded();
    const body = new ReadableStream<Uint8Array>({
      start(value) { bodyController = value; },
      async pull(value) {
        try {
          checkAbort(); if (closed) return;
          const next = await iterator!.next(); checkAbort(); if (closed) return;
          if (next.done) value.close(); else value.enqueue(next.value);
        } catch (error) { sourceError = error; value.error(error); stopSource(); }
      },
      cancel() { stopSource(); },
    }, { highWaterMark: 0 });
    const headers = Object.fromEntries(Object.entries(transport.headers).filter(([name]) => !reserved.has(name.toLowerCase())));
    headers["Content-Type"] = "application/octet-stream";
    headers["Accept-Encoding"] = "identity";
    headers["X-QCloud-Filename"] = encodeURIComponent(filename);
    headers["X-QCloud-Content-Type"] = contentType;
    if (size !== undefined) headers["Content-Length"] = String(size);
    const pendingResponse = transport.fetch(`${transport.baseURL}/generation/files`, {
      method: "POST", headers, body, duplex: "half", signal: controller.signal, redirect: "error",
    } as RequestInit & { duplex: "half" });
    response = await new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      void pendingResponse.then(value => {
        controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) { void value.body?.cancel().catch(() => {}); return; }
        resolve(value);
      }, error => { controller.signal.removeEventListener("abort", onAbort); reject(error); });
    });
    checkAbort();
    const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let length = 0;
    const stopReader = () => { void reader?.cancel().catch(() => {}); };
    controller.signal.addEventListener("abort", stopReader, { once: true });
    try {
      while (reader) {
        checkAbort(); const next = await reader.read(); checkAbort();
        if (next.done) break;
        const piece = next.value.slice(0, CHUNK - length); parts.push(piece); length += piece.length;
        if (length === CHUNK) {
          if (response.ok) throw new APIResponseValidationError("Upload response exceeds 64 KiB");
          break;
        }
      }
    } finally {
      controller.signal.removeEventListener("abort", stopReader);
      // A custom transport's cancel hook may never settle. Request cancellation
      // releases pending reads immediately; cleanup must not extend our deadline.
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    const raw = Buffer.concat(parts).toString("utf8"); let envelope: any;
    try { envelope = JSON.parse(raw); } catch { envelope = { error: { message: raw.slice(0, 500) || response.statusText } }; }
    raiseForStatus(response.status, envelope, response.headers);
    const file = envelope?.data;
    let id: string;
    try { id = normalizeUuid(file?.id, "file ID"); } catch { throw new APIResponseValidationError("Invalid uploaded file identity"); }
    if (response.status !== 201 || !complete || file.object !== "generation.file" || file.url !== `qcloud://files/${id}` ||
        file.filename !== filename || file.content_type !== contentType || file.size_bytes !== sent || file.sha256 !== sha256 ||
        typeof file.created_at !== "string" || !Number.isFinite(Date.parse(file.created_at)) ||
        typeof file.expires_at !== "string" || !(Date.parse(file.expires_at) > Date.parse(file.created_at))) {
      throw new APIResponseValidationError("Invalid uploaded file response");
    }
    return file as GenerationUploadedFile;
  } catch (error) {
    checkAbort();
    if (sourceError !== undefined) throw sourceError;
    if (error instanceof TypeError && response === undefined && iterator !== undefined) throw new APIConnectionError("Upload connection failed", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort); stopSource();
    if (handle) await handle.close().catch(() => {});
    void response?.body?.cancel().catch(() => {});
  }
}
