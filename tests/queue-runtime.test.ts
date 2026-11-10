import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { APIConnectionError, APIError, APIResponseValidationError, QCloud } from "../src/index.js";

const org = randomUUID(), draft = randomUUID(), eid = randomUUID(), jid = randomUUID(), quote = randomUUID();
const time = "2026-11-09T00:00:00.123456+00:00";
const endpoint = { id: eid, draft_id: draft, generation: 1, profile_id: "fixture-small", model: "Example/Model", state: "ready",
  created_at: time, deleted_at: null, financial_exposure: "held", requires_review: false };
const job = { id: jid, endpoint_id: eid, state: "submitted", created_at: time, finished_at: null, result_available: false,
  financial_exposure: "held", requires_review: true };
const result = { available: true, result: { text: "Hello", finish_reason: "stop", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } };
const input = { prompt: "Hello", max_tokens: 8 };
function fixture(value: unknown, status = 200) {
  const calls: { url: string; options: RequestInit }[] = [];
  const client = new QCloud({ apiKey: "qc-fixture", baseURL: "http://127.0.0.1:1/v1", organization: org, maxRetries: 3,
    fetch: async (url, options = {}) => { calls.push({ url: String(url), options }); return Response.json(value, { status }); } });
  return { runtime: client.serverless.queue.runtime, calls };
}

test("quotes bind target, request identity and intent, preserving exact USD strings", async () => {
  const requestId = randomUUID();
  for (const kind of ["endpoint", "job"] as const) {
    const target = kind === "endpoint" ? draft : eid;
    for (const amount of ["0.000001", "12.340000", "9007199254.740991"]) {
      const expected = { id: quote, client_request_id: requestId, kind, target_id: target, expires_at: time,
        currency: "USD", estimated_cost_usd: amount, funding_mode: "metered", is_spending_cap: false };
      const f = fixture({ data: { ...expected, provider_price: "private" } }, 201);
      const actual = kind === "endpoint" ? await f.runtime.endpoints.quote(draft.toUpperCase(), { client_request_id: requestId, org_id: org })
        : await f.runtime.jobs.quote(eid, { client_request_id: requestId, org_id: org, input });
      assert.deepEqual(actual, expected);
      assert.deepEqual(JSON.parse(f.calls[0].options.body as string), { client_request_id: requestId, org_id: org, ...(kind === "job" ? { input } : {}) });
      assert.ok(f.calls[0].url.endsWith(kind === "endpoint" ? `/deployments/${draft}/quote` : `/endpoints/${eid}/jobs/quote`));
    }
  }
});

test("quotes reject monetary coercion, mismatched binding and false cap claims", async () => {
  const requestId = randomUUID();
  const expected = { id: quote, client_request_id: requestId, kind: "endpoint", target_id: draft, expires_at: time,
    currency: "USD", estimated_cost_usd: "1.000000", funding_mode: "metered", is_spending_cap: false };
  for (const patch of [
    ...["0.000000", "-1.000000", "1", "1.0", "01.000000", "1e0", "9007199254.740992", "10000000000.000000", 1, null, "1.000000\n"].map(estimated_cost_usd => ({ estimated_cost_usd })),
    { id: "bad" }, { target_id: eid }, { client_request_id: randomUUID() }, { kind: "job" }, { currency: "EUR" },
    { funding_mode: "prepaid" }, { is_spending_cap: true }, { is_spending_cap: 0 }, { expires_at: "2026-02-30T00:00:00Z" },
  ]) {
    await assert.rejects(fixture({ data: { ...expected, ...patch } }).runtime.endpoints.quote(draft, { client_request_id: requestId }),
      error => error instanceof APIResponseValidationError && error.clientRequestId === requestId);
  }
});

test("quote mutations make one attempt and retain generated recovery identity", async () => {
  for (const status of [409, 429, 503]) {
    for (const isJob of [false, true]) {
      const f = fixture({ error: { message: "fixture" } }, status);
      await assert.rejects(isJob ? f.runtime.jobs.quote(eid, { input }, { maxRetries: 9 })
        : f.runtime.endpoints.quote(draft, {}, { maxRetries: 9 }), error => error instanceof APIError && /^[a-f0-9-]{36}$/.test(error.clientRequestId ?? ""));
      assert.equal(f.calls.length, 1);
    }
  }
  const f = fixture({});
  for (const input of [{ prompt: "", max_tokens: 1 }, { prompt: "ok", max_tokens: 0 }, { prompt: "ok", max_tokens: true },
    { prompt: "ok", max_tokens: 1, secret: true }])
    await assert.rejects(f.runtime.jobs.quote(eid, { input } as never), TypeError);
  await assert.rejects(f.runtime.endpoints.quote(draft, { quote_id: quote } as never), TypeError);
  assert.equal(f.calls.length, 0);
});

test("runtime capabilities remain inactive and public response fields are projected", async () => {
  const expected = { stage: "inactive", execution_available: false, billing_available: false };
  const f = fixture({ ...expected, provider: "private" });
  assert.deepEqual(await f.runtime.capabilities({ org_id: org.toUpperCase() }), expected);
  assert.ok(f.calls[0].url.endsWith(`/runtime/capabilities?org_id=${org}`));
  assert.equal(new Headers(f.calls[0].options.headers).get("x-qcloud-organization"), org);
  for (const value of [{ ...expected, execution_available: true }, { ...expected, billing_available: 0 }, { ...expected, stage: "active" }])
    await assert.rejects(fixture(value).runtime.capabilities(), APIResponseValidationError);
});

test("launch and job create use opaque quote, stable request identity and bounded public projection", async () => {
  const f = fixture({ data: { ...endpoint, provider_endpoint_id: "private", plan: { secret: true } } }, 201);
  assert.deepEqual(await f.runtime.endpoints.launch(draft.toUpperCase(), { quote_id: quote.toUpperCase(), org_id: org }), endpoint);
  const body = JSON.parse(f.calls[0].options.body as string);
  assert.deepEqual(body, { quote_id: quote, org_id: org, client_request_id: body.client_request_id });
  assert.match(body.client_request_id, /^[a-f0-9-]{36}$/);
  assert.ok(f.calls[0].url.endsWith(`/deployments/${draft}/launch`));
  const g = fixture({ data: { ...job, provider_job_id: "private" } });
  assert.deepEqual(await g.runtime.jobs.create(eid, { quote_id: quote, client_request_id: body.client_request_id, input }), job);
  assert.deepEqual(JSON.parse(g.calls[0].options.body as string), { quote_id: quote, client_request_id: body.client_request_id, input });
  assert.ok(g.calls[0].url.endsWith(`/endpoints/${eid}/jobs`));
});

test("all mutations disable transport retries; launch and submission preserve recovery UUID", async () => {
  for (const status of [409, 429, 503]) {
    for (const isJob of [false, true]) {
      const id = randomUUID(), f = fixture({ error: { message: "fixture", code: "request_conflict" } }, status);
      await assert.rejects(isJob ? f.runtime.jobs.create(eid, { quote_id: quote, client_request_id: id, input }, { maxRetries: 9 })
        : f.runtime.endpoints.launch(draft, { quote_id: quote, client_request_id: id }, { maxRetries: 9 }),
      error => error instanceof APIError && error.clientRequestId === id && error.status === status);
      assert.equal(f.calls.length, 1);
    }
    const f = fixture({ error: { message: "fixture" } }, status);
    await assert.rejects(f.runtime.endpoints.stop(eid, {}, { maxRetries: 9 }), APIError);
    assert.equal(f.calls.length, 1);
  }
  for (const transportError of [new TypeError("lost acknowledgement"), new Error("custom transport failure")]) {
    let attempts = 0;
    const c = new QCloud({ apiKey: "qc-fixture", maxRetries: 9, fetch: async () => { attempts++; throw transportError; } });
    await assert.rejects(c.serverless.queue.runtime.jobs.create(eid, { quote_id: quote, input }), error => {
      // Native fetch uses TypeError. Custom transports may throw a plain Error;
      // preserve that identity while still attaching the recovery UUID.
      assert.ok(transportError instanceof TypeError ? error instanceof APIConnectionError : error === transportError);
      return /^[a-f0-9-]{36}$/.test((error as Error & { clientRequestId?: string }).clientRequestId ?? "");
    });
    assert.equal(attempts, 1);
  }
});

test("list pages project two or more resources, validate identity, and preserve cursor", async () => {
  const second = { ...endpoint, id: randomUUID() }, cursor = { id: second.id, created_at: time };
  const f = fixture({ items: [{ ...endpoint, registry: "private" }, second], next_cursor: { ...cursor, token: "private" } });
  assert.deepEqual(await f.runtime.endpoints.list({ limit: 2, after_created_at: time, after_id: eid, org_id: org }), { items: [endpoint, second], next_cursor: cursor });
  const url = new URL(f.calls[0].url);
  assert.equal(url.searchParams.get("limit"), "2"); assert.equal(url.searchParams.get("after_created_at"), time);
  const g = fixture({ items: [job], next_cursor: null });
  assert.deepEqual(await g.runtime.jobs.list(eid), { items: [job], next_cursor: null });
  for (const value of [{ items: [endpoint, endpoint], next_cursor: null }, { items: [endpoint], next_cursor: cursor }, { items: [], next_cursor: cursor }, { items: [], next_cursor: {} }])
    await assert.rejects(fixture(value).runtime.endpoints.list(), APIResponseValidationError);
  await assert.rejects(f.runtime.endpoints.list({ limit: 1 }), APIResponseValidationError);
  await assert.rejects(fixture({ items: [{ ...job, endpoint_id: randomUUID() }], next_cursor: null }).runtime.jobs.list(eid), APIResponseValidationError);
});

test("get and create reject a different resource without losing request identity", async () => {
  assert.deepEqual(await fixture({ data: endpoint }).runtime.endpoints.retrieve(eid.toUpperCase()), endpoint);
  assert.deepEqual(await fixture({ data: job }).runtime.jobs.retrieve(eid, jid), job);
  await assert.rejects(fixture({ data: endpoint }).runtime.endpoints.retrieve(randomUUID()), APIResponseValidationError);
  await assert.rejects(fixture({ data: job }).runtime.jobs.retrieve(eid, randomUUID()), APIResponseValidationError);
  const id = randomUUID();
  await assert.rejects(fixture({ data: endpoint }).runtime.endpoints.launch(randomUUID(), { quote_id: quote, client_request_id: id }),
    error => error instanceof APIResponseValidationError && error.clientRequestId === id);
  await assert.rejects(fixture({ data: { ...job, endpoint_id: randomUUID() } }).runtime.jobs.create(eid, { quote_id: quote, client_request_id: id, input }),
    error => error instanceof APIResponseValidationError && error.clientRequestId === id);
});

test("stop keeps authoritative exposure including repeated cancellation", async () => {
  for (const value of [{ released: true, financial_exposure: "none" }, { released: false, financial_exposure: "none" }, { released: false, financial_exposure: "held" }]) {
    const f = fixture({ ...value, reservation: "private" });
    assert.deepEqual(await f.runtime.endpoints.stop(eid, { org_id: org }), value);
    assert.deepEqual(JSON.parse(f.calls[0].options.body as string), { org_id: org });
  }
  await assert.rejects(fixture({ released: true, financial_exposure: "held" }).runtime.endpoints.stop(eid), APIResponseValidationError);
});

test("job results require completion and timestamps must be real calendar dates", async () => {
  for (const value of [{ ...job, result_available: true }, { ...job, created_at: "2026-02-30T00:00:00Z" }, { ...job, finished_at: "2026-02-30T00:00:00Z" }])
    await assert.rejects(fixture({ data: value }).runtime.jobs.retrieve(eid, jid), APIResponseValidationError);
  const valid = { ...job, state: "completed", result_available: true };
  assert.deepEqual(await fixture({ data: valid }).runtime.jobs.retrieve(eid, jid), valid);
});

test("results validate bounded text and accounting and strip pending/private data", async () => {
  assert.deepEqual(await fixture({ ...result, result: { ...result.result, provider: "private" } }).runtime.jobs.result(eid, jid), result);
  assert.deepEqual(await fixture({ available: false, result: { private: true } }).runtime.jobs.result(eid, jid), { available: false });
  for (const value of [{ available: true }, { ...result, result: { ...result.result, text: "😀".repeat(16385) } },
    { ...result, result: { ...result.result, text: "\ud800" } }, { ...result, result: { ...result.result, text: "\0" } },
    { ...result, result: { ...result.result, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 6 } } },
    { ...result, result: { ...result.result, usage: { input_tokens: 0, output_tokens: 4097, total_tokens: 4097 } } }])
    await assert.rejects(fixture(value).runtime.jobs.result(eid, jid), APIResponseValidationError);
});

test("invalid requests fail before HTTP and validation errors retain generated identity", async () => {
  const f = fixture({ data: job });
  for (const input of [{ prompt: "", max_tokens: 1 }, { prompt: "😀".repeat(4097), max_tokens: 1 }, { prompt: "\ud800", max_tokens: 1 },
    { prompt: "\0", max_tokens: 1 }, { prompt: "ok", max_tokens: 4097 }, { prompt: "ok", max_tokens: true }, { prompt: "ok", max_tokens: 1, secret: true }])
    await assert.rejects(f.runtime.jobs.create(eid, { quote_id: quote, input } as never), error => error instanceof TypeError && typeof (error as any).clientRequestId === "string");
  for (const params of [{ limit: 0 }, { limit: 51 }, { after_id: eid }, { after_created_at: time }, { after_id: eid, after_created_at: "today" }, { secret: true }])
    await assert.rejects(f.runtime.endpoints.list(params as never), TypeError);
  await assert.rejects(f.runtime.jobs.create(eid, { quote_id: "https://evil.example", input }), TypeError);
  await assert.rejects(f.runtime.endpoints.retrieve("https://evil.example"), TypeError);
  assert.equal(f.calls.length, 0);
});

test("runtime UUID parsing rejects nil, unknown version and non-RFC variants", async () => {
  for (const invalid of ["00000000-0000-0000-0000-000000000000", "11111111-1111-9111-8111-111111111111", "11111111-1111-4111-7111-111111111111"]) {
    const f = fixture({ data: endpoint });
    await assert.rejects(f.runtime.endpoints.launch(draft, { quote_id: invalid }), TypeError);
    await assert.rejects(f.runtime.endpoints.retrieve(invalid), TypeError);
    assert.equal(f.calls.length, 0);
    await assert.rejects(fixture({ data: { ...endpoint, draft_id: invalid } }).runtime.endpoints.retrieve(eid), APIResponseValidationError);
    await assert.rejects(fixture({ data: { ...job, id: invalid } }).runtime.jobs.retrieve(eid, jid), APIResponseValidationError);
  }
});
