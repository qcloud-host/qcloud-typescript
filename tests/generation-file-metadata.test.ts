import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { QCloud, APIError, APIConnectionError, APIResponseValidationError, APITimeoutError, AuthenticationError, PermissionDeniedError, NotFoundError } from "../src/index.js";

const id = "abcdef12-3456-4789-abcd-ef1234567890";
const receipt = { id, object: "generation.file", url: `qcloud://files/${id}`, filename: "εικόνα.png", content_type: "image/png", size_bytes: 123,
  sha256: "a".repeat(64), created_at: "2026-11-08T10:00:00+00:00", expires_at: "2026-11-15T10:00:00Z" };

test("uploaded file metadata uses the configured origin, canonical ID and organization", async () => {
  let requests = 0;
  const sdk = new QCloud({ apiKey: "qc-fixture", organization: id, baseURL: "https://qcloud.example/api/v1", fetch: async (url, options) => {
    requests++; assert.equal(url, `https://qcloud.example/api/v1/generation/files/${id}`); assert.equal(options?.method, "GET");
    const headers = new Headers(options?.headers); assert.equal(headers.get("authorization"), "Bearer qc-fixture"); assert.equal(headers.get("x-qcloud-organization"), id);
    assert.equal(options?.redirect, "error"); return Response.json({ data: receipt });
  } });
  assert.deepEqual(await sdk.generation.files.retrieve(id.toUpperCase()), receipt);
  for (const invalid of ["https://foreign.example/file", `qcloud://files/${id}`, "../file", `${id}\n`, id.replaceAll("-", "")]) {
    await assert.rejects(sdk.generation.files.retrieve(invalid), /UUID/);
  }
  assert.equal(requests, 1);
});

test("metadata rejects mismatched identities, unsafe URLs and malformed receipt fields", async () => {
  let data: unknown;
  const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => Response.json(data) });
  const invalid = [
    { id: "fedcba98-7654-4321-abcd-0123456789ab" }, { id: id.toUpperCase() }, { object: "file" },
    { url: "https://foreign.example/file" }, { url: `qcloud://files/${id}?key=secret` }, { filename: "../file" },
    { filename: "\u0085file" }, { filename: "é".repeat(128) }, { filename: "\ud800" }, { filename: " " },
    { content_type: "image/png\n" }, { content_type: "Image/PNG" }, { content_type: "image/png; charset=utf8" },
    { size_bytes: 0 }, { size_bytes: true }, { size_bytes: 268435457 }, { size_bytes: 1.5 },
    { sha256: "A".repeat(64) }, { sha256: "a".repeat(64) + "\n" },
    { created_at: "not a date" }, { created_at: "2026-11-08T10:00:00" }, { expires_at: receipt.created_at },
  ];
  for (const patch of invalid) { data = { data: { ...receipt, ...patch } }; await assert.rejects(sdk.generation.files.retrieve(id), APIResponseValidationError); }
  for (const malformed of [null, [], {}, { data: null }, { data: [] }]) { data = malformed; await assert.rejects(sdk.generation.files.retrieve(id), APIResponseValidationError); }
});

test("file metadata preserves authorization, missing/foreign and expired HTTP errors", async () => {
  for (const [status, expected] of [[401, AuthenticationError], [403, PermissionDeniedError], [404, NotFoundError], [410, APIError]] as const) {
    let requests = 0;
    const sdk = new QCloud({ apiKey: "qc-fixture", maxRetries: 3, fetch: async () => {
      requests++; return Response.json({ error: { code: status === 410 ? "input_file_expired" : "input_file_not_found", message: "File unavailable" } }, { status, headers: { "x-request-id": "metadata-request" } });
    } });
    await assert.rejects(sdk.generation.files.retrieve(id), e => e instanceof expected && e.status === status && e.requestID === "metadata-request");
    assert.equal(requests, 1);
  }
});

test("metadata redirects cannot forward keys and timeout/cancellation close in-flight HTTP", async () => {
  let mode = "redirect", outside = 0, disconnected = 0;
  const foreign = createServer((_req, res) => { outside++; res.end("unexpected"); }); foreign.listen(0, "127.0.0.1"); await once(foreign, "listening");
  const server = createServer((_req, res) => {
    if (mode === "redirect") { res.writeHead(302, { location: `http://127.0.0.1:${(foreign.address() as { port: number }).port}/file` }); res.end(); }
    else { res.on("close", () => { disconnected++; }); res.writeHead(200, { "content-type": "application/json" }); res.write('{"data":'); }
  }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const sdk = new QCloud({ apiKey: "qc-fixture", baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`, maxRetries: 0 });
  try {
    await assert.rejects(sdk.generation.files.retrieve(id), APIConnectionError); assert.equal(outside, 0);
    mode = "stall"; await assert.rejects(sdk.generation.files.retrieve(id, { timeout: 50 }), APITimeoutError);
    const controller = new AbortController(), reason = new Error("cancel metadata");
    const pending = sdk.generation.files.retrieve(id, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 50); await assert.rejects(pending, e => e === reason);
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(disconnected, 2);
  } finally {
    server.closeAllConnections(); foreign.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => foreign.close(() => resolve()))]);
  }
});
