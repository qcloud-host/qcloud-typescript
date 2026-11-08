import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { APIError, APIResponseValidationError, APITimeoutError, QCloud } from "../src/index.js";

async function fixture() {
  const id = randomUUID();
  const state = { posts: 0, offers: 0, closed: 0, failure: 0, mode: "complete", transport: "websocket", capability: null as Record<string, unknown> | null, bodies: [] as unknown[], tokens: [] as string[], urls: [] as string[] };
  const session = (status = "created") => ({ object: "generation.session", id, model: "qcloud/session", transport: state.transport, status, created_at: "2026-11-06T00:00:00Z", updated_at: "2026-11-06T00:00:00Z", connected_at: null, completed_at: null, deadline_at: null, expires_at: "2026-11-06T00:05:00Z", max_duration_seconds: 300, close_requested: status === "closed", error: null, license: null, billing: { mode: "metered", status: "pending", currency: "USD", markup_multiplier: 2, cost_usd: null } });
  const server = createServer(async (req, res) => {
    state.urls.push(req.url!); res.setHeader("x-request-id", "session-fixture");
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (raw) state.bodies.push(JSON.parse(raw));
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/generation/sessions") {
      state.posts++; if (state.failure) return json({ error: { type: "unavailable", message: "fixture unavailable" } }, state.failure);
      state.transport = JSON.parse(raw).transport; return json({ data: session() }, 201);
    }
    if (req.url?.endsWith("/connect")) return json({ data: state.capability ?? (state.transport === "websocket" ? { transport: "websocket", session_id: id, websocket_url: "wss://qcloud.example.test/realtime", token: "single-use", subprotocols: ["qcloud.realtime.v1", "qcloud.cap.single-use"], expires_at: "2026-11-06T00:00:30Z", encoding: "msgpack" } : { transport: "webrtc", session_id: id, url: "https://qcloud.example.test/offer", token: "single-use", expires_at: "2026-11-06T00:00:30Z" }) }, 201);
    if (req.url?.endsWith("/close")) return json({ data: session("closed") }, 202);
    if (req.url?.endsWith("/offer")) {
      state.offers++; state.tokens.push(req.headers["x-qcloud-session-token"] as string); res.on("close", () => state.closed++);
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
      if (state.mode === "stall") return;
      if (state.mode === "error") return res.end('event: error\ndata: {"error":{"code":"session_failed","message":"Session failed"}}\n\n');
      const answer = `event: answer\r\ndata: ${JSON.stringify({ session_id: state.mode === "mismatch" ? randomUUID() : id, type: "answer", sdp: "v=0\r\ns=🌍" })}\r\n\r\n`;
      const bytes = Buffer.from(answer); for (let offset = 0; offset < bytes.length; offset += 3) res.write(bytes.subarray(offset, offset + 3));
      if (state.mode === "hold") { const timer = setInterval(() => res.write(": keepalive\n\n"), 10); res.on("close", () => clearInterval(timer)); return; }
      if (state.mode === "duplicate") res.write(answer);
      if (state.mode === "complete") res.write(`: keepalive\n\nevent: closed\ndata: ${JSON.stringify({ session_id: id, reason: "session_finished" })}\n\n`);
      if (state.mode === "truncated_closed") res.write(`event: closed\ndata: ${JSON.stringify({ session_id: id, reason: "session_finished" })}`);
      return res.end();
    }
    return json({ data: session() });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const sdk = new QCloud({ apiKey: "qc-test", baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, maxRetries: 3 });
  return { id, sdk, state, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("session control handles both capability transports and stable submission identity", async () => {
  const f = await fixture();
  try {
    for (const transport of ["websocket", "webrtc"] as const) {
      const requestId = randomUUID();
      assert.equal((await f.sdk.generation.sessions.create({ model: "qcloud/session", transport, billing_mode: "metered", client_request_id: requestId })).id, f.id);
      assert.equal((f.state.bodies.at(-1) as { client_request_id: string }).client_request_id, requestId);
      assert.equal((await f.sdk.generation.sessions.retrieve(f.id)).transport, transport);
      const capability = await f.sdk.generation.sessions.connect(f.id); assert.equal(capability.transport, transport); assert.equal(capability.token, "single-use");
      assert.equal((await f.sdk.generation.sessions.close(f.id)).status, "closed");
    }
    f.state.failure = 429; const before = f.state.posts, requestId = randomUUID();
    await assert.rejects(f.sdk.generation.sessions.create({ model: "qcloud/session", transport: "websocket", billing_mode: "metered", client_request_id: requestId }), error => error instanceof APIError && error.clientRequestId === requestId);
    assert.equal(f.state.posts, before + 1);
  } finally { await f.close(); }
});

test("connection capabilities distinguish media transport from signaling and reject unknown protocols", async () => {
  const f = await fixture();
  const rtc = { transport: "webrtc", signaling: "websocket", protocol: "rtc-signaling-v1", session_id: f.id, websocket_url: "wss://qcloud.example.test/realtime", token: "single-use", subprotocols: ["qcloud.realtime.v1", "qcloud.cap.single-use"], expires_at: "2026-11-06T00:00:30Z", encoding: "msgpack" };
  try {
    f.state.capability = rtc;
    const capability = await f.sdk.generation.sessions.connect(f.id);
    assert.equal(capability.transport, "webrtc");
    if (capability.transport !== "webrtc" || capability.signaling !== "websocket") assert.fail("Expected a WebRTC signaling socket");
    assert.equal(capability.protocol, "rtc-signaling-v1");
    assert.equal(capability.websocket_url, rtc.websocket_url);
    assert.equal(capability.encoding, "msgpack");
    assert.ok(!capability.websocket_url.includes(capability.token));
    for (const override of [{ protocol: "unknown" }, { protocol: undefined }, { encoding: "json" }, { signaling: "unknown" }, { transport: "unknown" }, { websocket_url: "" }, { subprotocols: [] }, { session_id: randomUUID() }]) {
      f.state.capability = { ...rtc, ...override };
      await assert.rejects(f.sdk.generation.sessions.connect(f.id), APIResponseValidationError);
    }
    f.state.capability = { transport: "webrtc", signaling: "sse", session_id: f.id, url: "https://qcloud.example.test/offer", token: "single-use", expires_at: rtc.expires_at };
    assert.equal((await f.sdk.generation.sessions.connect(f.id)).signaling, "sse");
    f.state.capability = { ...rtc, transport: "websocket", protocol: undefined };
    assert.equal((await f.sdk.generation.sessions.connect(f.id)).transport, "websocket");
    assert.equal(f.state.offers, 0, "Reading a capability never starts a paid session");
  } finally { await f.close(); }
});

test("session offer parses fragmented Unicode, terminal closure and aborts on early iterator exit", async () => {
  const f = await fixture();
  try {
    const events = [];
    for await (const event of await f.sdk.generation.sessions.offer(f.id, { sdp: "offer", type: "offer" }, { sessionToken: "single-use" })) events.push(event);
    assert.deepEqual(events.map(event => event.event), ["answer", "closed"]); assert.equal(events[0].data.sdp, "v=0\r\ns=🌍");
    assert.deepEqual(f.state.tokens, ["single-use"]); assert.ok(f.state.urls.every(url => !url.includes("single-use")));
    f.state.mode = "hold"; const before = f.state.closed;
    for await (const event of await f.sdk.generation.sessions.offer(f.id, { sdp: "offer", type: "offer" }, { sessionToken: "single-use" })) { assert.equal(event.event, "answer"); break; }
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.state.closed, before + 1);
  } finally { await f.close(); }
});

test("session offer errors, duplicate answers and unexpected EOF never succeed silently", async () => {
  for (const mode of ["error", "duplicate", "mismatch", "truncated", "truncated_closed"]) {
    const f = await fixture(); f.state.mode = mode;
    try {
      const consume = async () => { for await (const _event of await f.sdk.generation.sessions.offer(f.id, { sdp: "offer", type: "offer" }, { sessionToken: "single-use" })) { /* Consume all events. */ } };
      await assert.rejects(consume(), error => mode === "error" ? error instanceof APIError && error.requestID === "session-fixture" : error instanceof APIResponseValidationError);
      assert.equal(f.state.offers, 1);
    } finally { await f.close(); }
  }
});

test("session offers retain transport timeouts and reject malformed local inputs", async () => {
  const f = await fixture(); f.state.mode = "stall";
  try {
    const consume = async () => { for await (const _event of await f.sdk.generation.sessions.offer(f.id, { sdp: "offer", type: "offer" }, { sessionToken: "single-use", timeout: 35 })) { /* Wait. */ } };
    await assert.rejects(consume(), APITimeoutError); assert.equal(f.state.offers, 1);
    await assert.rejects(f.sdk.generation.sessions.create({ model: "x", transport: "websocket", billing_mode: "metered", max_duration_seconds: 0 }), /max_duration/);
    assert.throws(() => f.sdk.generation.sessions.offer(f.id, { sdp: "offer", type: "offer" }, { sessionToken: "bad\r\ntoken" }), /token/);
    assert.equal(f.state.posts, 0);
  } finally { await f.close(); }
});

test("uppercase session UUIDs work for control, capabilities and streamed event identity", async () => {
  const f = await fixture(), upper = f.id.toUpperCase();
  const requestId = "ABCDEF12-3456-4789-ABCD-EF1234567890";
  const params = { model: "qcloud/session", transport: "webrtc" as const, billing_mode: "metered" as const, client_request_id: requestId };
  try {
    await f.sdk.generation.sessions.create(params);
    assert.equal((f.state.bodies[0] as { client_request_id: string }).client_request_id, requestId.toLowerCase());
    assert.equal((await f.sdk.generation.sessions.retrieve(upper)).id, f.id);
    const capability = await f.sdk.generation.sessions.connect(upper);
    assert.equal(capability.session_id, f.id);
    const stream = await f.sdk.generation.sessions.offer(upper, { type: "offer", sdp: "offer" }, { sessionToken: capability.token });
    assert.equal(stream.sessionId, f.id);
    const events = []; for await (const event of stream) events.push(event);
    assert.deepEqual(events.map(event => event.event), ["answer", "closed"]);
    assert.equal((await f.sdk.generation.sessions.close(upper)).id, f.id);
    assert.ok(f.state.urls.filter(url => url !== "/v1/generation/sessions").every(url => url.startsWith(`/v1/generation/sessions/${f.id}`)));
    f.state.failure = 503;
    await assert.rejects(f.sdk.generation.sessions.create(params), error => error instanceof APIError && error.clientRequestId === requestId.toLowerCase());
    f.state.mode = "mismatch";
    await assert.rejects(async () => { for await (const _ of await f.sdk.generation.sessions.offer(upper, { type: "offer", sdp: "offer" }, { sessionToken: "single-use" })) { /* Consume the mismatched answer. */ } }, APIResponseValidationError);
  } finally { await f.close(); }
});

test("malformed session UUIDs and alternate UUID forms fail before HTTP", async () => {
  const f = await fixture();
  try {
    for (const id of [`{${f.id}}`, f.id.replaceAll("-", ""), ` ${f.id}`, `${f.id}\n`, `g${f.id.slice(1)}`, f.id.slice(1)]) {
      await assert.rejects(f.sdk.generation.sessions.retrieve(id), /UUID/);
      await assert.rejects(f.sdk.generation.sessions.connect(id), /UUID/);
      await assert.rejects(f.sdk.generation.sessions.close(id), /UUID/);
      assert.throws(() => f.sdk.generation.sessions.offer(id, { type: "offer", sdp: "offer" }, { sessionToken: "single-use" }), /UUID/);
      await assert.rejects(f.sdk.generation.sessions.create({ model: "qcloud/session", transport: "websocket", billing_mode: "metered", client_request_id: id }), /UUID/);
    }
    assert.deepEqual(f.state.urls, []);
  } finally { await f.close(); }
});

function bufferedSession(id: string): Uint8Array {
  return Buffer.from(`event: answer\ndata: ${JSON.stringify({ session_id: id, type: "answer", sdp: "v=0\r\ns=🌍" })}\n\nevent: closed\ndata: ${JSON.stringify({ session_id: id, reason: "session_finished" })}\n\n`);
}

test("buffered session events stop on explicit close, abort and deadline without another request", async () => {
  for (const mode of ["close", "abort", "deadline"] as const) {
    const id = randomUUID(), abort = new AbortController(), reason = Error("caller stopped");
    let requests = 0, cancelled = 0;
    const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => {
      requests++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bufferedSession(id)); }, cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
    } });
    const stream = await sdk.generation.sessions.offer(id, { type: "offer", sdp: "v=0" }, { sessionToken: "single-use", signal: abort.signal, timeout: mode === "deadline" ? 40 : 1000 });
    const events = stream[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.event, "answer");
    if (mode === "close") { await stream.close(); assert.equal((await events.next()).done, true); }
    else if (mode === "abort") { abort.abort(reason); await assert.rejects(events.next(), error => error === reason); }
    else { await new Promise(resolve => setTimeout(resolve, 65)); await assert.rejects(events.next(), APITimeoutError); }
    assert.equal(cancelled, 1); assert.equal(requests, 1);
  }
});

test("session UTF-8 errors are validation failures, including a truncated code point at EOF", async () => {
  for (const truncated of [false, true]) {
    const id = randomUUID(); let cancelled = 0, requests = 0;
    const body = truncated ? Buffer.from([0xe2, 0x82]) : Buffer.concat([Buffer.from(`event: answer\ndata: {"session_id":"${id}","type":"answer","sdp":"v=0`), Buffer.from([0xff]), Buffer.from('"}\n\n')]);
    const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => {
      requests++; let sent = false;
      return new Response(new ReadableStream({ pull(controller) { if (sent) controller.close(); else { sent = true; controller.enqueue(body); } }, cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
    } });
    const stream = await sdk.generation.sessions.offer(id, { type: "offer", sdp: "v=0" }, { sessionToken: "single-use" });
    await assert.rejects(async () => { for await (const _ of stream) assert.fail("Malformed UTF-8 cannot produce an SDP answer"); }, error => error instanceof APIResponseValidationError && /UTF-8/.test(error.message));
    assert.equal(requests, 1); assert.ok(cancelled <= 1);
  }
});

test("session lines are bounded before newline or EOF and limits count UTF-8 bytes", async () => {
  for (const mode of ["no-newline", "unicode", "multiline"] as const) {
    const id = randomUUID(); let pulls = 0, cancelled = 0;
    const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => new Response(new ReadableStream({
      pull(controller) {
        pulls++;
        if (mode === "no-newline") {
          assert.ok(pulls <= 35, "The SDK must reject before asking for an unbounded line");
          controller.enqueue(Buffer.alloc(65_536, 120));
        } else if (pulls === 1) controller.enqueue(Buffer.from(mode === "unicode" ? `data: ${"世".repeat(750_000)}\n\n` : `data: ${"世".repeat(360_000)}\ndata: ${"世".repeat(360_000)}\n\n`));
        else controller.close();
      }, cancel() { cancelled++; },
    }), { headers: { "content-type": "text/event-stream" } }) });
    const stream = await sdk.generation.sessions.offer(id, { type: "offer", sdp: "v=0" }, { sessionToken: "single-use" });
    await assert.rejects(async () => { for await (const _ of stream) assert.fail("An oversized event must not be delivered"); }, error => error instanceof APIResponseValidationError && /size limit/.test(error.message));
    assert.ok(cancelled <= 1);
    if (mode === "no-newline") { assert.ok(pulls <= 34); assert.equal(cancelled, 1); }
  }
});

test("session limits apply per event rather than to a large transport chunk or stream lifetime", async () => {
  const id = randomUUID();
  const bytes = Buffer.concat([Buffer.from((":" + "x".repeat(65_000) + "\r\n").repeat(50)), bufferedSession(id)]);
  let cancelled = 0;
  const sdk = new QCloud({ apiKey: "qc-fixture", fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } }) });
  const events = [];
  for await (const event of await sdk.generation.sessions.offer(id, { type: "offer", sdp: "v=0" }, { sessionToken: "single-use" })) events.push(event);
  assert.deepEqual(events.map(event => event.event), ["answer", "closed"]);
  assert.equal(events[0].data.sdp, "v=0\r\ns=🌍"); assert.equal(cancelled, 1);
});
