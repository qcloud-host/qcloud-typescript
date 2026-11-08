import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { QCloud, APIConnectionError, APIResponseValidationError, APITimeoutError, PermissionDeniedError } from "../src/index.js";

const job = "abcdef12-3456-4789-abcd-ef1234567890", asset = "fedcba98-7654-4321-abcd-0123456789ab";
const path = `/api/v1/generation/jobs/${job}/files/${asset}`;
const payload = Buffer.from(Array.from({ length: 150001 }, (_, n) => n % 256));
async function fixture() {
  const state = { mode: "complete", requests: 0, outside: 0, aborted: 0, paths: [] as string[], headers: {} as Record<string, string | string[] | undefined> };
  const outside = createServer((_req, res) => { state.outside++; res.end("secret must never arrive here"); });
  outside.listen(0, "127.0.0.1"); await once(outside, "listening");
  const server = createServer((req, res) => {
    state.requests++; state.headers = req.headers;
    state.paths.push(req.url ?? "");
    if (req.url !== path || req.method !== "GET" || req.headers.authorization !== "Bearer qc-fixture") { res.writeHead(403); res.end(); return; }
    res.on("close", () => { if (!res.writableEnded) state.aborted++; });
    if (state.mode === "redirect") { res.writeHead(302, { location: `http://127.0.0.1:${(outside.address() as { port: number }).port}/foreign` }); res.end(); return; }
    if (state.mode === "error") { res.writeHead(403, { "content-type": "application/json", "x-request-id": "req-denied" }); res.end(JSON.stringify({ error: { message: "No access" } })); return; }
    if (state.mode === "large-header") { res.writeHead(200, { "content-length": "9999999" }); res.flushHeaders(); return; }
    if (state.mode === "stall") { res.writeHead(200); res.write(Buffer.alloc(65536, 1)); return; }
    if (state.mode === "truncated") { res.writeHead(200, { "content-length": "1000000" }); res.write(Buffer.alloc(65536, 1)); setTimeout(() => res.destroy(), 25); return; }
    let body = payload;
    if (req.headers.range) { body = payload.subarray(4, 20); res.statusCode = 206; res.setHeader("content-range", `bytes 4-19/${payload.length}`); }
    res.setHeader("content-type", "video/mp4"); res.setHeader("content-length", body.length); res.setHeader("accept-ranges", "bytes"); res.setHeader("x-request-id", "req-media"); res.end(body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { state, sdk: new QCloud({ apiKey: "qc-fixture", organization: job, baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`, maxRetries: 5 }),
    close: async () => { server.closeAllConnections(); outside.closeAllConnections(); await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => outside.close(() => r()))]); } };
}
async function collect(download: AsyncIterable<Uint8Array>) { const chunks = []; for await (const chunk of download) { assert.ok(chunk.length <= 65536); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks); }

test("files stream exact binary bytes with canonical IDs, metadata and byte ranges", async () => {
  const f = await fixture();
  try {
    const download = await f.sdk.generation.files.download(job.toUpperCase(), asset.toUpperCase());
    assert.equal(download.contentType, "video/mp4"); assert.equal(download.contentLength, payload.length); assert.equal(download.requestID, "req-media");
    assert.deepEqual(await collect(download), payload); assert.equal(download.bytesRead, payload.length);
    await assert.rejects(collect(download), /already been consumed/); await download.close();
    const range = await f.sdk.generation.files.download(job, asset, { range: "bytes=4-19" });
    assert.equal(range.status, 206); assert.equal(range.contentRange, `bytes 4-19/${payload.length}`); assert.deepEqual(await collect(range), payload.subarray(4, 20));
    assert.deepEqual(f.state.paths, [path, path]); assert.equal(f.state.headers.range, "bytes=4-19");
    assert.equal(f.state.headers["x-qcloud-organization"], job);
    assert.ok(String(f.state.headers["accept-encoding"]).split(",").every(value => value.trim() === "identity"));
  } finally { await f.close(); }
});

test("file errors are typed, redirects never receive credentials and downloads never retry", async () => {
  const f = await fixture();
  try {
    f.state.mode = "error";
    await assert.rejects(f.sdk.generation.files.download(job, asset), e => e instanceof PermissionDeniedError && e.requestID === "req-denied");
    assert.equal(f.state.requests, 1);
    f.state.mode = "redirect"; await assert.rejects(f.sdk.generation.files.download(job, asset), APIConnectionError);
    assert.equal(f.state.outside, 0); assert.equal(f.state.requests, 2);
    f.state.mode = "truncated"; const truncated = await f.sdk.generation.files.download(job, asset);
    await assert.rejects(collect(truncated), APIConnectionError); assert.equal(f.state.requests, 3);
  } finally { await f.close(); }
});

test("file timeout, caller cancellation and early iteration exit close the response", async () => {
  const f = await fixture();
  try {
    f.state.mode = "stall";
    const timed = await f.sdk.generation.files.download(job, asset, { timeout: 70 });
    await assert.rejects(collect(timed), APITimeoutError);
    const controller = new AbortController(), reason = new Error("caller cancelled");
    const cancelled = await f.sdk.generation.files.download(job, asset, { signal: controller.signal });
    const reading = collect(cancelled); controller.abort(reason); await assert.rejects(reading, e => e === reason);
    const early = await f.sdk.generation.files.download(job, asset); for await (const _ of early) break;
    await early.close(); await new Promise(r => setTimeout(r, 40)); assert.equal(f.state.aborted, 3);
  } finally { await f.close(); }
});

test("file size limits work with and without Content-Length, before excess bytes are yielded", async () => {
  const f = await fixture();
  try { f.state.mode = "large-header"; await assert.rejects(f.sdk.generation.files.download(job, asset, { maxBytes: 5000 }), APIResponseValidationError); }
  finally { await f.close(); }
  let produced = 0, cancelled = false;
  const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => new Response(new ReadableStream<Uint8Array>({
    pull(c) { produced++; c.enqueue(new Uint8Array(4096)); }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 })) });
  const file = await sdk.generation.files.download(job, asset, { maxBytes: 5000 });
  assert.equal(produced, 0, "download must not eagerly buffer the body");
  let yielded = 0;
  await assert.rejects(async () => { for await (const bytes of file) yielded += bytes.length; }, APIResponseValidationError);
  assert.equal(yielded, 4096); assert.equal(cancelled, true); assert.equal(produced, 2);
});

test("unsafe identifiers, ranges and sizes fail before HTTP and encoded bodies are rejected", async () => {
  let calls = 0;
  const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => { calls++; return new Response(new Uint8Array([1]), { headers: { "content-encoding": "gzip" } }); } });
  for (const id of ["https://foreign.invalid/file", "../secret", `${asset}\n`, asset.replaceAll("-", "")]) assert.throws(() => sdk.generation.files.download(job, id), /UUID/);
  for (const range of ["bytes=-", "bytes=4-1", "bytes=0-1,4-5", "bytes=0-1\r\nAuthorization:x", "bytes=0-1\n", "bytes=-0"]) assert.throws(() => sdk.generation.files.download(job, asset, { range }), /range/);
  for (const maxBytes of [0, -1, Infinity, 1.5, 268435457]) assert.throws(() => sdk.generation.files.download(job, asset, { maxBytes }), /maxBytes/);
  assert.equal(calls, 0); await assert.rejects(sdk.generation.files.download(job, asset), APIResponseValidationError);
});

test("error diagnostics are bounded and close an oversized response", async () => {
  let produced = 0, cancelled = false;
  const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => new Response(new ReadableStream<Uint8Array>({
    pull(c) { produced++; c.enqueue(new Uint8Array(65536).fill(120)); }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 403, headers: { "x-request-id": "bounded-error" } }) });
  await assert.rejects(sdk.generation.files.download(job, asset), e => e instanceof PermissionDeniedError && e.requestID === "bounded-error" && e.message.length < 600);
  assert.equal(produced, 1); assert.equal(cancelled, true);
});

test("abort or close between slices of one large transport chunk yields no further bytes", async () => {
  for (const mode of ["abort", "close"] as const) {
    let cancelled = false;
    const controller = new AbortController(), reason = new Error("stop between chunks");
    const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(150000)); }, cancel() { cancelled = true; },
    })) });
    const file = await sdk.generation.files.download(job, asset, { signal: controller.signal });
    const iterator = file[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.length, 65536);
    if (mode === "abort") { controller.abort(reason); await assert.rejects(iterator.next(), error => error === reason); }
    else { await file.close(); assert.equal((await iterator.next()).done, true); }
    assert.equal(cancelled, true);
  }
});

test("diagnostic body timeout cancels its reader even when injected fetch ignores abort", async () => {
  let cancelled = false;
  const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { status: 403 }) });
  await assert.rejects(sdk.generation.files.download(job, asset, { timeout: 30 }), APITimeoutError);
  assert.equal(cancelled, true);
});
