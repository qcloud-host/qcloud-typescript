import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// We test the client in isolation by mocking global fetch.

describe("QCloudAI", () => {
  // Dynamic import after env setup
  let QCloudAI: typeof import("../src/client.js").QCloudAI;

  beforeEach(async () => {
    process.env.QCLOUD_API_KEY = "qc-test-key";
    const mod = await import("../src/client.js");
    QCloudAI = mod.QCloudAI;
  });

  it("throws if no API key is provided", () => {
    delete process.env.QCLOUD_API_KEY;
    assert.throws(() => new QCloudAI({ apiKey: "" }), /No API key/);
  });

  it("uses default base URL", () => {
    const client = new QCloudAI();
    assert.equal(client.baseURL, "https://qcloud.host/api/v1");
  });

  it("accepts custom base URL", () => {
    const client = new QCloudAI({ baseURL: "https://custom.host/v1/" });
    assert.equal(client.baseURL, "https://custom.host/v1");
  });

  it("builds correct auth headers", () => {
    const client = new QCloudAI({ apiKey: "qc-my-key" });
    const headers = client._buildHeaders();
    assert.equal(headers["Authorization"], "Bearer qc-my-key");
    assert.equal(headers["Content-Type"], "application/json");
    assert.match(headers["User-Agent"], /qcloud-ai-node/);
  });
});

describe("Chat Completions", () => {
  const MOCK_RESPONSE = {
    id: "chatcmpl-abc",
    object: "chat.completion" as const,
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };

  it("creates a chat completion", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    try {
      const { QCloudAI } = await import("../src/client.js");
      const client = new QCloudAI({ apiKey: "qc-test" });
      const result = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
      });

      assert.equal(result.id, "chatcmpl-abc");
      assert.equal(result.choices[0].message.content, "Hello!");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws AuthenticationError on 401", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "Invalid API key", type: "auth_error" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    try {
      const { QCloudAI } = await import("../src/client.js");
      const { AuthenticationError } = await import("../src/error.js");
      const client = new QCloudAI({ apiKey: "qc-bad" });

      await assert.rejects(
        () =>
          client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "Hi" }],
          }),
        (err: unknown) => {
          assert.ok(err instanceof AuthenticationError);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws RateLimitError on 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "Rate limited", type: "rate_limit_error" },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    try {
      const { QCloudAI } = await import("../src/client.js");
      const { RateLimitError } = await import("../src/error.js");
      const client = new QCloudAI({ apiKey: "qc-test" });

      await assert.rejects(
        () =>
          client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "Hi" }],
          }),
        (err: unknown) => {
          assert.ok(err instanceof RateLimitError);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Completions", () => {
  const MOCK_RESPONSE = {
    id: "cmpl-abc",
    object: "text_completion" as const,
    created: 1700000000,
    model: "gpt-3.5-turbo-instruct",
    choices: [{ index: 0, text: "Once upon a time", finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };

  it("creates a text completion", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    try {
      const { QCloudAI } = await import("../src/client.js");
      const client = new QCloudAI({ apiKey: "qc-test" });
      const result = await client.completions.create({
        model: "gpt-3.5-turbo-instruct",
        prompt: "Once upon",
      });

      assert.equal(result.choices[0].text, "Once upon a time");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Models", () => {
  const MOCK_RESPONSE = {
    object: "list" as const,
    data: [
      {
        id: "gpt-4o-mini",
        object: "model" as const,
        created: 1700000000,
        owned_by: "qcloud",
      },
    ],
  };

  it("lists models", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    try {
      const { QCloudAI } = await import("../src/client.js");
      const client = new QCloudAI({ apiKey: "qc-test" });
      const result = await client.models.list();

      assert.equal(result.object, "list");
      assert.equal(result.data[0].id, "gpt-4o-mini");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Embeddings", () => {
  const MOCK_RESPONSE = {
    object: "list" as const,
    data: [
      { object: "embedding" as const, index: 0, embedding: [0.1, 0.2, 0.3] },
    ],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 2, total_tokens: 2 },
  };

  it("creates embeddings", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    try {
      const { QCloudAI } = await import("../src/client.js");
      const client = new QCloudAI({ apiKey: "qc-test" });
      const result = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: "Hello",
      });

      assert.equal(result.data.length, 1);
      assert.equal(result.data[0].embedding.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
