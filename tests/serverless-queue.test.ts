import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { APIConnectionError, APIError, APIResponseValidationError, QCloud } from "../src/index.js";

const org = randomUUID(), id = randomUUID();
const profile = { id: "fixture-small", name: "Small model", model: "Example/Model", gpu_memory_gb: 24, disk_gb: 30, pricing: null,
  limits: { max_workers: 1, idle_timeout_seconds: 90, execution_timeout_seconds: 600 } };
const draft = { id, name: "SDK draft", status: "draft", profile_id: profile.id, profile_name: profile.name, model: profile.model,
  created_at: "2026-11-09T00:00:00+00:00", updated_at: "2026-11-09T00:00:00.123Z" };
const catalog = { stage: "draft_preview", runtime_available: false, creation_available: true, profiles: [profile], unsupported: ["job-execution"] };
function fixture(value: unknown, status = 200) {
  const calls: { url: string; options: RequestInit }[] = [];
  const client = new QCloud({ apiKey: "qc-fixture", baseURL: "http://127.0.0.1:1/v1", organization: org, maxRetries: 3,
    fetch: async (url, options = {}) => { calls.push({ url: String(url), options }); return Response.json(value, { status }); } });
  return { client, calls };
}

test("queue resources validate catalog and expose only draft planning", async () => {
  const f = fixture({ ...catalog, provider: "private", profiles: [{ ...profile, image: "private", gpu_pools: ["private"] }] });
  assert.deepEqual(await f.client.serverless.queue.catalog({ org_id: org.toUpperCase() }), catalog);
  assert.equal(f.calls[0].url, `http://127.0.0.1:1/v1/serverless/queue/catalog?org_id=${org}`);
  assert.equal(new Headers(f.calls[0].options.headers).get("authorization"), "Bearer qc-fixture");
  assert.equal(new Headers(f.calls[0].options.headers).get("x-qcloud-organization"), org);
  assert.equal("run" in f.client.serverless.queue, false);
  assert.equal("launch" in f.client.serverless.queue.deployments, false);
  assert.deepEqual(await fixture({ ...catalog, profiles: [], creation_available: false }).client.serverless.queue.catalog(), { ...catalog, profiles: [], creation_available: false });
});

test("draft create generates one stable UUID, trims name and projects private fields", async () => {
  const f = fixture({ data: { ...draft, native_endpoint_id: "private", profile_snapshot: {} } }, 201);
  assert.deepEqual(await f.client.serverless.queue.deployments.create({ name: "  SDK draft  ", profile_id: profile.id, org_id: org }), draft);
  const body = JSON.parse(f.calls[0].options.body as string);
  assert.match(body.client_request_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(body, { name: draft.name, profile_id: profile.id, org_id: org, client_request_id: body.client_request_id });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.redirect, "error");
  assert.equal(f.calls[0].options.method, "POST");
});

test("draft errors preserve typed error and request UUID without POST retries", async () => {
  for (const status of [409, 429, 503]) {
    const requestId = randomUUID(), f = fixture({ error: { message: "fixture error", code: "request_conflict" } }, status);
    await assert.rejects(f.client.serverless.queue.deployments.create({ name: draft.name, profile_id: profile.id, client_request_id: requestId.toUpperCase() }, { maxRetries: 9 }),
      error => error instanceof APIError && error.status === status && error.clientRequestId === requestId);
    assert.equal(f.calls.length, 1);
  }
  let calls = 0;
  const client = new QCloud({ apiKey: "qc-fixture", maxRetries: 9, fetch: async () => { calls++; throw new TypeError("lost acknowledgement"); } });
  let saved: string | undefined;
  await assert.rejects(client.serverless.queue.deployments.create({ name: draft.name, profile_id: profile.id }), error => {
    assert.ok(error instanceof APIConnectionError); saved = error.clientRequestId; return typeof saved === "string" && /^[a-f0-9-]{36}$/.test(saved);
  });
  assert.equal(calls, 1);
});

test("list/retrieve validate identity, bounded cardinality and public projection", async () => {
  assert.deepEqual(await fixture({ data: [{ ...draft, provider_key: "private" }] }).client.serverless.queue.deployments.list(), { data: [draft] });
  const f = fixture({ data: draft });
  assert.deepEqual(await f.client.serverless.queue.deployments.retrieve(id.toUpperCase(), { org_id: org }), draft);
  assert.ok(f.calls[0].url.endsWith(`/deployments/${id}?org_id=${org}`));
  await assert.rejects(f.client.serverless.queue.deployments.retrieve(randomUUID()), APIResponseValidationError);
  for (const value of [null, {}, { data: [draft, draft] }, { data: Array(101).fill(draft) }]) {
    await assert.rejects(fixture(value).client.serverless.queue.deployments.list(), APIResponseValidationError);
  }
});

test("invalid draft request inputs fail before HTTP, including newline profile and arbitrary URL ID", async () => {
  const f = fixture({ data: draft });
  for (const params of [ { name: "x", profile_id: profile.id }, { name: "x\u0001y", profile_id: profile.id }, { name: "😀".repeat(41), profile_id: profile.id },
    { name: draft.name, profile_id: "fixture-small\n" }, { name: draft.name, profile_id: profile.id, client_request_id: "bad" },
    { name: draft.name, profile_id: profile.id, org_id: "bad" }, { name: draft.name, profile_id: profile.id, image: "evil" } ]) {
    await assert.rejects(f.client.serverless.queue.deployments.create(params), TypeError);
  }
  await assert.rejects(f.client.serverless.queue.deployments.retrieve("https://other.example/private"), TypeError);
  await assert.rejects(f.client.serverless.queue.catalog({ org_id: "bad" }), TypeError);
  assert.equal(f.calls.length, 0);
});

test("malformed draft/catalog responses fail closed and create retains recovery UUID", async () => {
  for (const value of [{ ...draft, status: "running" }, { ...draft, id: "provider-id" }, { ...draft, created_at: "today" }, { ...draft, name: "Different draft" }]) {
    const requestId = randomUUID();
    await assert.rejects(fixture({ data: value }).client.serverless.queue.deployments.create({ name: draft.name, profile_id: profile.id, client_request_id: requestId }),
      error => error instanceof APIResponseValidationError && error.clientRequestId === requestId);
  }
  for (const value of [{ ...catalog, runtime_available: true }, { ...catalog, creation_available: false }, { ...catalog, profiles: [profile, profile] },
    { ...catalog, profiles: [{ ...profile, pricing: 0 }] }, { ...catalog, profiles: [{ ...profile, limits: { ...profile.limits, max_workers: 2 } }] },
    { ...catalog, profiles: [{ ...profile, gpu_memory_gb: "24" }] }]) {
    await assert.rejects(fixture(value).client.serverless.queue.catalog(), APIResponseValidationError);
  }
});
