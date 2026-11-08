// Upload one local input; this does not submit a generation job.
import { QCloud } from "qcloud-ai";

const path = process.argv[2];
if (!path) throw new Error("Usage: node upload-file.mjs <local-path> [content-type]");
const client = new QCloud();
const file = await client.generation.files.upload({ path }, {
  contentType: process.argv[3] ?? "application/octet-stream", maxBytes: 64 * 1024 * 1024,
});
console.log({ id: file.id, inputReference: file.url, size: file.size_bytes, sha256: file.sha256 });
