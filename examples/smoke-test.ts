// Runs the examples against a local fake QCloud API (no network, no billing).
//   npm run build && npx tsx examples/smoke-test.ts
// The fake implements only the wire shapes the examples use. It proves the
// examples run and handle errors as documented; it is not a backend contract.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const TEXT = "γειά 🌍";
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
let rateLimitOnce = false;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "req-smoke", ...headers }).end(JSON.stringify(body));
}
function sse(res: ServerResponse, events: object[], named = false) {
  res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req-smoke" });
  for (const event of events) res.write(`${named ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
  res.end(named ? "" : "data: [DONE]\n\n");
}
async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

const fake = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer qc-smoke");
  if (req.method === "GET" && req.url?.endsWith("/models")) return json(res, 200, { object: "list", data: [{ id: "fake/chat", object: "model" }] });
  const payload = await body(req);
  if (req.url?.endsWith("/chat/completions")) {
    const prompt = payload.messages[0].content;
    if (prompt === "rate-limit" || rateLimitOnce) {
      rateLimitOnce = false;
      return json(res, 429, { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Slow down" } }, { "retry-after": "0" });
    }
    if (prompt === "no-credits") return json(res, 402, { error: { type: "billing_error", message: "Insufficient credits" } });
    if (payload.stream) {
      const common = { id: "c", object: "chat.completion.chunk", created: 1, model: payload.model };
      return sse(res, [{ ...common, choices: [{ index: 0, delta: { content: TEXT }, finish_reason: "stop" }] }, { ...common, choices: [], usage }]);
    }
    return json(res, 200, { id: "c", object: "chat.completion", created: 1, model: payload.model, usage,
      choices: [{ index: 0, message: { role: "assistant", content: TEXT }, finish_reason: "stop" }] });
  }
  if (req.url?.endsWith("/messages")) {
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    const message = { id: "m", type: "message", role: "assistant", model: payload.model, content: [{ type: "text", text: TEXT }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 7, output_tokens: 3 } };
    if (!payload.stream) return json(res, 200, message);
    return sse(res, [
      { type: "message_start", message: { ...message, content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXT } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 7, output_tokens: 3 } },
      { type: "message_stop" },
    ], true);
  }
  json(res, 404, { error: { message: "Not found" } });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  QCLOUD_API_KEY: "qc-smoke", QCLOUD_MODEL: "fake/chat",
  QCLOUD_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
});

try {
  const script = async (name: string) => (await run(process.execPath, [here + name], { env: process.env, timeout: 60_000 })).stdout;
  assert.ok((await script("quickstart.mjs")).includes(TEXT));
  const messages = await script("messages.mjs");
  assert.equal(messages.split(TEXT).length - 1, 2, messages);
  rateLimitOnce = true; // first worker request gets 429 and is retried
  const worker = await script("worker.mjs");
  assert.equal(worker.split(" done ").length - 1, 2, worker);
  console.log("scripts ok");

  const { server } = await import("./node-server.mjs");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const app = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, message: string) => fetch(app + path, { method: "POST", body: JSON.stringify({ message }) });
  const chat = await post("/chat", "hi");
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).reply, TEXT);
  const streamed = await (await post("/chat/stream", "hi")).text();
  assert.ok(streamed.includes(TEXT) && streamed.endsWith("data: [DONE]\n\n"));
  const limited = await post("/chat", "rate-limit");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "0");
  assert.equal(limited.headers.get("x-qcloud-request-id"), "req-smoke");
  assert.equal((await post("/chat", "no-credits")).status, 402);
  server.close();
  console.log("node server ok");

  const route = await import("./nextjs/app/api/chat/route.ts");
  const ok = await route.POST(new Request("http://app/api/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) }));
  assert.equal(ok.status, 200);
  assert.ok((await ok.text()).includes(TEXT));
  const denied = await route.POST(new Request("http://app/api/chat", { method: "POST", body: JSON.stringify({ message: "rate-limit" }) }));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "0");
  console.log("nextjs route ok");
} finally {
  fake.close();
}
