import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QCloudAI,
  AuthenticationError,
  APIResponseValidationError,
  APIError,
  APITimeoutError,
  APIConnectionError,
} from "../src/index.js";
import { Stream } from "../src/streaming.js";
const params = {
  model: "test-model",
  messages: [{ role: "user", content: "Hi" }],
};
const json = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const completion = {
  id: "chat-test",
  object: "chat.completion",
  model: "test-model",
  created: 1,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello" },
      finish_reason: "stop",
    },
  ],
};
function client(fetcher: typeof fetch, extra = {}) {
  return new QCloudAI({
    apiKey: "qc-test",
    fetch: fetcher,
    maxRetries: 0,
    ...extra,
  });
}
test("streaming HTTP errors are raised before iteration and retain request id", async () => {
  const c = client(async () =>
    json({ error: { message: "No access" } }, 401, {
      "x-request-id": "req-test",
    }),
  );
  await assert.rejects(
    c.chat.completions.create({ ...params, stream: true }),
    (e) => e instanceof AuthenticationError && e.requestID === "req-test",
  );
});
test("retry-after and configured retries work for rate limits", async () => {
  let calls = 0;
  const c = client(
    async () =>
      ++calls === 1
        ? json({ error: {} }, 429, { "retry-after": "0" })
        : json(completion),
    { maxRetries: 1 },
  );
  assert.equal((await c.chat.completions.create(params)).id, "chat-test");
  assert.equal(calls, 2);
});
test("authentication errors are never retried", async () => {
  let calls = 0;
  const c = client(
    async () => {
      calls++;
      return json({ error: {} }, 401);
    },
    { maxRetries: 3 },
  );
  await assert.rejects(c.models.list(), AuthenticationError);
  assert.equal(calls, 1);
});
test("HTML error pages remain typed HTTP errors", async () => {
  await assert.rejects(
    client(
      async () => new Response("upstream unavailable", { status: 502 }),
    ).models.list(),
    (e) => e instanceof APIError && e.status === 502,
  );
});
test("unexpected success formats fail visibly", async () => {
  await assert.rejects(
    client(async () => new Response("<html>")).models.list(),
    APIResponseValidationError,
  );
  await assert.rejects(
    client(async () => json(completion)).chat.completions.create({
      ...params,
      stream: true,
    }),
    APIResponseValidationError,
  );
});
test("SSE supports byte fragmentation, unicode, CRLF, multiline data, comments and DONE", async () => {
  const input =
    ': ping\r\ndata:{"text":\r\ndata: "γειά 🌍"}\r\n\r\ndata: [DONE]\r\n\r\ndata: {"ignored":true}\n\n';
  const bytes = new TextEncoder().encode(input);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const out = [];
  for await (const item of new Stream<{ text: string }>(new Response(body)))
    out.push(item);
  assert.deepEqual(out, [{ text: "γειά 🌍" }]);
  assert.equal(cancelled, true);
  await assert.rejects(async () => {
    for await (const _ of new Stream(new Response('data:{"x":1}'))) {}
  }, /ended before \[DONE\]/);
});
test("ambiguous POST failures are not replayed, even with retries enabled", async () => {
  for (const failure of [503, 408, 409, "network"] as const) {
    let calls = 0;
    const c = client(async () => {
      calls++;
      if (failure === "network") throw new TypeError("connection reset");
      return json({ error: { message: "upstream failed" } }, failure);
    }, { maxRetries: 2 });
    await assert.rejects(c.chat.completions.create(params), failure === "network" ? APIConnectionError : APIError);
    assert.equal(calls, 1);
  }
});
test("read-only catalog requests still retry transient server failures", async () => {
  let calls = 0;
  const c = client(async () => ++calls === 1
    ? json({ error: {} }, 503, { "retry-after": "0" })
    : json({ object: "list", data: [] }), { maxRetries: 1 });
  assert.deepEqual((await c.models.list()).data, []);
  assert.equal(calls, 2);
});
test("organization selection is sent explicitly and invalid IDs fail early", async () => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const c = client(async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("x-qcloud-organization"), organization);
    return json({ object: "list", data: [] });
  }, { organization });
  await c.models.list();
  assert.throws(() => client(fetch, { organization: "not-an-id" }), /organization/);
});
test("streamed provider errors retain the request ID", async () => {
  const response = new Response('data:{"error":{"message":"failed"}}\n\n', { headers: { "x-request-id": "request-stream" } });
  await assert.rejects(async () => {
    for await (const _ of new Stream(response)) {}
  }, (e) => e instanceof APIError && e.requestID === "request-stream");
});
test("breaking a stream cancels its body and releases cleanup", async () => {
  let cancelled = false,
    cleaned = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('data:{"ok":true}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const stream = new Stream(new Response(body), () => cleaned++);
  for await (const _ of stream) break;
  await stream.abort();
  assert.equal(cancelled, true);
  assert.equal(cleaned, 1);
});
test("stream error payloads and malformed data are surfaced", async () => {
  for (const [payload, ErrorType] of [
    ['{"error":{"message":"Provider failed"}}', APIError],
    ["not-json", APIResponseValidationError],
    ["null", APIResponseValidationError],
    ["[]", APIResponseValidationError],
  ] as const) {
    await assert.rejects(async () => {
      for await (const _ of new Stream(new Response(`data:${payload}\n\n`))) {
      }
    }, ErrorType);
  }
});
test("caller cancellation prevents transmission", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    client(async () => {
      calls++;
      return json(completion);
    }).chat.completions.create(params, { signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(calls, 0);
});
test("timeout remains active while consuming a stream", async () => {
  const c = client(
    async (_u, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(control) {
            init?.signal?.addEventListener("abort", () =>
              control.error(new DOMException("Aborted", "AbortError")),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { timeout: 25 },
  );
  const stream = await c.chat.completions.create({ ...params, stream: true });
  await assert.rejects(async () => {
    for await (const _ of stream) {
    }
  }, APITimeoutError);
});

function bufferedStreamClient(extra = {}) {
  return client(async () => new Response(
    'data: {"choices":[{"delta":{"content":"first"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"second"}}]}\n\n' +
    'data: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  ), extra);
}

test("caller cancellation discards events already buffered between yields", async () => {
  const controller = new AbortController();
  const stream = await bufferedStreamClient().chat.completions.create(
    { ...params, stream: true }, { signal: controller.signal },
  );
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.choices[0].delta.content, "first");
  const reason = new Error("stop after first chunk");
  controller.abort(reason);
  await assert.rejects(iterator.next(), (error) => error === reason);
});

test("explicit stream abort discards events already buffered between yields", async () => {
  const stream = await bufferedStreamClient().chat.completions.create({ ...params, stream: true });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await stream.abort();
  assert.equal((await iterator.next()).done, true);
});

test("a deadline during a consumer pause discards buffered stream events", async () => {
  const stream = await bufferedStreamClient({ timeout: 20 }).chat.completions.create({ ...params, stream: true });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(iterator.next(), APITimeoutError);
});
test("model ids are encoded and multimodal/tool parameters are preserved", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const c = client(async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return json(completion);
  });
  await c.models.retrieve("org/model?x");
  assert.ok(calls[0].url.endsWith("/models/org%2Fmodel%3Fx"));
  const request = {
    ...params,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe it" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/a.png" },
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: { name: "weather", parameters: { type: "object" } },
      },
    ],
    response_format: { type: "json_object" },
  };
  await c.chat.completions.create(request);
  assert.deepEqual(calls[1].body, request);
});
test("invalid configuration fails before network access", () => {
  assert.throws(
    () => new QCloudAI({ apiKey: "x", maxRetries: -1 }),
    /maxRetries/,
  );
  assert.throws(() => new QCloudAI({ apiKey: "x", timeout: 0 }), /timeout/);
  assert.throws(
    () => new QCloudAI({ apiKey: "x", baseURL: "https://key@example.com/v1" }),
    /baseURL/,
  );
});
