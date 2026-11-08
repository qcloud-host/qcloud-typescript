import type { QCloudAI } from "../client.js";
import { GenerationFile, MAX_DOWNLOAD_BYTES } from "../download.js";
import { normalizeUuid } from "../uuid.js";

export interface GenerationDownloadOptions {
  signal?: AbortSignal;
  /** Milliseconds for headers and the complete body, including consumer pauses. */
  timeout?: number;
  /** Total returned bytes, at most 256 MiB. No complete-file buffer is allocated. */
  maxBytes?: number;
  /** One byte range, for example bytes=0-1023 or bytes=-1024. */
  range?: string;
}

export class GenerationFiles {
  constructor(private client: QCloudAI) {}
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
