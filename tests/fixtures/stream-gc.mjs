import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { QCloud, APITimeoutError } from "../../src/index.ts";

assert.equal(typeof global.gc, "function");
let calls = 0, closed = 0;
const server = createServer((req, res) => {
  calls++;
  req.resume();
  res.once("close", () => closed++);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.flushHeaders(); // Intentionally never send an event or finish the response.
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
try {
  for (const kind of ["chat", "session"]) for (const reason of ["deadline", "caller"]) {
    const caller = new AbortController(), sentinel = new Error("Caller cancelled");
    const sdk = new QCloud({ apiKey: "fixture-only", baseURL, timeout: reason === "deadline" ? 200 : 5000, maxRetries: 3 });
    const options = { signal: caller.signal };
    const stream = kind === "chat"
      ? await sdk.chat.completions.create({ model: "fixture", messages: [{ role: "user", content: "Hi" }], stream: true }, options)
      : await sdk.generation.sessions.offer(randomUUID(), { type: "offer", sdp: "v=0\r\n" }, { ...options, sessionToken: "fixture-only" });
    const abort = reason === "caller" ? setTimeout(() => caller.abort(sentinel), 200) : undefined;
    const gc = setInterval(() => global.gc(), 15);
    let timer;
    try {
      const consuming = (async () => { for await (const event of stream) assert.fail(`Unexpected ${event}`); })();
      const bounded = Promise.race([consuming, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Stream ignored cancellation")), 2000); })]);
      await assert.rejects(bounded, error => reason === "deadline" ? error instanceof APITimeoutError : error === sentinel);
      for (let n = 0; closed < calls && n < 50; n++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(closed, calls, "Aborting must close the native HTTP response");
    } finally {
      clearInterval(gc); clearTimeout(abort); clearTimeout(timer);
      await stream.abort();
    }
  }
  assert.equal(calls, 4, "No billed POST is replayed");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
