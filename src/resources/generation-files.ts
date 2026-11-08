import type { QCloudAI, RequestOptions } from "../client.js";
import { APIResponseValidationError } from "../error.js";
import { GenerationFile, MAX_DOWNLOAD_BYTES } from "../download.js";
import { normalizeUuid } from "../uuid.js";
import type { GenerationUploadOptions, GenerationUploadSource } from "../upload.js";
import type { GenerationUploadedFile } from "../types/generation.js";

export interface GenerationDownloadOptions {
  signal?: AbortSignal;
  /** Milliseconds for headers and the complete body, including consumer pauses. */
  timeout?: number;
  /** Total returned bytes, at most 256 MiB. No complete-file buffer is allocated. */
  maxBytes?: number;
  /** One byte range, for example bytes=0-1023 or bytes=-1024. */
  range?: string;
}

function uploadedFile(value: unknown, expectedId: string): GenerationUploadedFile {
  const file = (value as { data?: GenerationUploadedFile } | null)?.data;
  const mime = typeof file?.content_type === "string" ? /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.exec(file.content_type) : null;
  const timestamp = (value: unknown): value is string => typeof value === "string" && !/\s/.test(value) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!file || Array.isArray(file) || file.object !== "generation.file" || file.id !== expectedId || file.url !== `qcloud://files/${expectedId}` ||
      typeof file.filename !== "string" || !file.filename.trim() || [".", ".."].includes(file.filename) || Buffer.byteLength(file.filename, "utf8") > 255 ||
      /[\p{Cc}/\\]/u.test(file.filename) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(file.filename) ||
      !mime || mime[0].length !== file.content_type.length || file.content_type.length > 127 ||
      !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 1 || file.size_bytes > MAX_DOWNLOAD_BYTES ||
      typeof file.sha256 !== "string" || file.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !timestamp(file.created_at) || !timestamp(file.expires_at) || Date.parse(file.expires_at) <= Date.parse(file.created_at)) {
    throw new APIResponseValidationError("Invalid or mismatched uploaded file metadata");
  }
  return file;
}

export class GenerationFiles {
  constructor(private client: QCloudAI) {}
  upload(source: GenerationUploadSource, options?: GenerationUploadOptions): Promise<GenerationUploadedFile> {
    return this.client._upload(source, options);
  }
  /** Retrieve an input upload's metadata, never its bytes or an arbitrary URL. */
  async retrieve(fileId: string, options?: RequestOptions): Promise<GenerationUploadedFile> {
    fileId = normalizeUuid(fileId, "file ID");
    return uploadedFile(await this.client._request("GET", `/generation/files/${fileId}`, options), fileId);
  }
  download(jobId: string, assetId: string, options: GenerationDownloadOptions = {}): Promise<GenerationFile> {
    jobId = normalizeUuid(jobId, "job ID"); assetId = normalizeUuid(assetId, "asset ID");
    const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DOWNLOAD_BYTES) throw new TypeError("maxBytes must be an integer from 1 to 268435456");
    if (options.range !== undefined) {
      const match = /^bytes=(\d{1,16})?-(\d{1,16})?$/.exec(options.range);
      if (!match || match[0].length !== options.range.length || (!match[1] && !match[2]) || [match[1], match[2]].some(n => n !== undefined && !Number.isSafeInteger(Number(n))) ||
          (!match[1] && Number(match[2]) === 0) || (match[1] && match[2] && Number(match[2]) < Number(match[1]))) throw new TypeError("range must be one valid byte range");
    }
    return this.client._request("GET", `/generation/jobs/${jobId}/files/${assetId}`, {
      signal: options.signal, timeout: options.timeout, maxRetries: 0,
      headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity", ...(options.range ? { Range: options.range } : {}) },
      binary: { jobId, assetId, maxBytes },
    });
  }
}
