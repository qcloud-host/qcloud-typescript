import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QCloud,
  APIError,
  APIConnectionError,
  APIResponseValidationError,
  BadRequestError,
  ConflictError,
  InsufficientCreditsError,
  RateLimitError,
  UnprocessableEntityError,
  messageText,
  type MessageStreamEvent,
} from "../src/index.js";

const params = { model: "test-model", messages: [{ role: "user" as const, content: "Hi" }] };
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const completion = {
  id: "chat-test", object: "chat.completion", model: "test-model", created: 1,
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
};
const message = {
  id: "msg_1", type: "message", role: "assistant", model: "test-model",
  content: [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }],
  stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 },
};
const sse = (...events: object[]) =>
  new Response(events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "x-request-id": "req-s" },
  });
function client(fetcher: typeof fetch, extra = {}) {
  return new QCloud({ apiKey: "qc-test", fetch: fetcher, maxRetries: 0, ...extra });
}
function refused(code = "ECONNREFUSED"): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connect failed"), { code }) });
}

test("rate-limit errors expose request ID, Retry-After, limits and code", async () => {
  const c = client(async () => json(
    { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Slow down" } }, 429,
    {
      "x-request-id": "req-429", "retry-after": "7",
      "x-ratelimit-limit-requests": "60", "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-limit-tokens": "100000", "x-ratelimit-remaining-tokens": "12",
    },
  ));
  await assert.rejects(c.chat.completions.create(params), (e) => {
    assert.ok(e instanceof RateLimitError && e instanceof APIError);
    assert.equal(e.requestID, "req-429");
    assert.equal(e.code, "rate_limit_exceeded");
    assert.equal(e.retryAfter, 7);
    assert.deepEqual(e.rateLimit, { limitRequests: 60, remainingRequests: 0, limitTokens: 100000, remainingTokens: 12 });
    assert.equal(e.headers?.get("x-ratelimit-remaining-tokens"), "12");
    return true;
  });
});

test("HTTP-date Retry-After and absent limits", async () => {
  const when = new Date(Date.now() + 30_000).toUTCString();
  const c = client(async () => json({ error: { message: "Top up" } }, 402, { "retry-after": when }));
  await assert.rejects(c.chat.completions.create(params), (e) => {
    assert.ok(e instanceof InsufficientCreditsError);
    assert.ok(e.retryAfter! > 0 && e.retryAfter! <= 30);
    assert.equal(e.rateLimit, undefined);
    assert.equal(e.errorType, "billing_error");
    return true;
  });
});

for (const [status, Cls, serverType] of [
  [400, BadRequestError, "invalid_request_error"],
  [409, ConflictError, "schema_unavailable"],
  [422, UnprocessableEntityError, undefined],
] as const) {
  test(`${status} maps to ${Cls.name} and keeps server type and code`, async () => {
    const c = client(async () => json({ error: { message: "nope", code: "capability_rejected", ...(serverType ? { type: serverType } : {}) } }, status));
    await assert.rejects(c.chat.completions.create(params), (e) => {
      assert.ok(e instanceof Cls && e instanceof APIError);
      assert.equal(e.code, "capability_rejected");
      if (serverType) assert.equal(e.errorType, serverType);
      return true;
    });
  });
}

test("Anthropic request-id header is used when X-Request-ID is absent", async () => {
  const c = client(async () => json(
    { type: "error", error: { type: "authentication_error", message: "bad key" }, request_id: "r-1" }, 401, { "request-id": "r-1" },
  ));
  await assert.rejects(c.messages.create({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }), (e) =>
    e instanceof APIError && e.requestID === "r-1" && e.errorType === "authentication_error");
});

test("POST connection failures before send are retried", async () => {
  let calls = 0;
  const c = client(async () => { if (++calls === 1) throw refused(); return json(completion); }, { maxRetries: 1 });
  assert.equal((await c.chat.completions.create(params)).id, "chat-test");
  assert.equal(calls, 2);
  let aggregate = 0;
  const c2 = client(async () => {
    if (++aggregate === 1) {
      const errors = [Object.assign(new Error("v4"), { code: "ECONNREFUSED" }), Object.assign(new Error("v6"), { code: "ENETUNREACH" })];
      throw new TypeError("fetch failed", { cause: Object.assign(new AggregateError(errors), { code: undefined }) });
    }
    return json(completion);
  }, { maxRetries: 1 });
  await c2.chat.completions.create(params);
  assert.equal(aggregate, 2);
});

test("ambiguous POST failures after send are not replayed", async () => {
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", undefined]) {
    let calls = 0;
    const c = client(async () => { calls++; throw code ? refused(code) : new TypeError("terminated"); }, { maxRetries: 3 });
    await assert.rejects(c.chat.completions.create(params), APIConnectionError);
    assert.equal(calls, 1, `code ${code}`);
  }
});

test("connect failures exhaust the configured retries", async () => {
  let calls = 0;
  const c = client(async () => { calls++; throw refused("ENOTFOUND"); }, { maxRetries: 2 });
  await assert.rejects(c.chat.completions.create(params), APIConnectionError);
  assert.equal(calls, 3);
});

test("messages.create sends anthropic-version and returns a Message", async () => {
  let request: Request | undefined;
  const c = client(async (input, init) => { request = new Request(input as string, init); return json(message); });
  const result = await c.messages.create({ model: "test-model", max_tokens: 16, system: "Be brief", messages: [{ role: "user", content: "hi" }] });
  assert.equal(messageText(result), "Hello");
  assert.equal(result.usage.output_tokens, 2);
  assert.ok(request!.url.endsWith("/api/v1/messages"));
  assert.equal(request!.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(request!.headers.get("authorization"), "Bearer qc-test");
  assert.deepEqual(await request!.json(), { model: "test-model", max_tokens: 16, system: "Be brief", messages: [{ role: "user", content: "hi" }] });
});

test("messages stream ends at message_stop and keeps Unicode deltas", async () => {
  const events = [
    { type: "message_start", message: { ...message, content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "γειά 🌍" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 2 } },
    { type: "message_stop" },
  ];
  let body: any;
  const c = client(async (_input, init) => { body = JSON.parse(String(init?.body)); return sse(...events); });
  const received: MessageStreamEvent[] = [];
  for await (const event of await c.messages.create({ model: "m", max_tokens: 8, messages: [], stream: true })) received.push(event);
  assert.equal(body.stream, true);
  assert.equal(received.at(-1)?.type, "message_stop");
  assert.equal(received.filter((e) => e.type === "content_block_delta").map((e) => e.delta?.text).join(""), "γειά 🌍");
  assert.deepEqual(received[4].usage, { input_tokens: 3, output_tokens: 2 });
});

test("messages stream truncation and error events fail explicitly", async () => {
  const truncated = client(async () => sse({ type: "message_start", message }));
  await assert.rejects(async () => {
    for await (const _ of await truncated.messages.create({ model: "m", max_tokens: 8, messages: [], stream: true })) { /* drain */ }
  }, (e) => e instanceof APIResponseValidationError && /terminal event/.test(e.message));
  const failing = client(async () => sse({ type: "message_start", message }, { type: "error", error: { type: "overloaded_error", message: "Provider overloaded" } }));
  await assert.rejects(async () => {
    for await (const _ of await failing.messages.create({ model: "m", max_tokens: 8, messages: [], stream: true })) { /* drain */ }
  }, (e) => e instanceof APIError && e.errorType === "overloaded_error" && e.requestID === "req-s");
});
