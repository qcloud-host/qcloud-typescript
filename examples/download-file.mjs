// Download an existing generated asset. This does not submit a generation job.
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { QCloud } from "qcloud-ai";

const client = new QCloud();
const file = await client.generation.files.download(
  process.env.QCLOUD_JOB_ID, process.env.QCLOUD_ASSET_ID,
  { maxBytes: 64 * 1024 * 1024, timeout: 120_000 },
);
try {
  await pipeline(Readable.from(file), createWriteStream("output.bin", { flags: "wx" }));
} finally { await file.close(); }
