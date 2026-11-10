import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { QCloud, GenerationSocketError, APIResponseValidationError } from "../src/index.js";

async function fixture() {
  const id = randomUUID(), token = randomBytes(32).toString("base64url");
  const state = { connects: 0, closes: 0, upgrades: 0, authorization: [] as (string | undefined)[],
    protocols: [] as (string | undefined)[], mode: "normal", closeFailure: false,
    capability: {} as Record<string, unknown>, onSocket: undefined as ((socket: WebSocket) => void) | undefined };
  let origin = "";
  const session = () => ({ object: "generation.session", id, transport: "websocket", status: "closed", billing: { status: "pending" } });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume empty request */ }
    const json = (body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.url?.endsWith("/connect")) {
      state.connects++;
      assert.equal(request.headers.authorization, "Bearer qc-secret-never-on-socket");
      return json({ data: { session_id: id, transport: "websocket", signaling: "websocket", encoding: "json", token,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        websocket_url: `${origin.replace("http:", "ws:")}/v1/generation/sessions/${id}/socket`,
        subprotocols: ["qcloud.realtime.v1", `qcloud.cap.${token}`], ...state.capability } }, 201);
    }
    if (request.url?.endsWith("/close")) {
      state.closes++;
      if (state.closeFailure) return json({ error: { message: "fixture failure" } }, 503);
      return json({ data: session() }, 202);
    }
    json({ error: { message: "not found" } }, 404);
  });
  const connections = new Set<Socket>(); server.on("connection", socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false,
    handleProtocols: () => state.mode === "wrong-protocol" ? "unexpected" : "qcloud.realtime.v1" });
  server.on("upgrade", (request, socket, head) => {
    state.upgrades++; state.authorization.push(request.headers.authorization); state.protocols.push(request.headers["sec-websocket-protocol"]);
    assert.equal(request.headers["x-api-secret"], undefined);
    assert.equal(request.url?.includes(token), false);
    if (state.mode === "redirect") { socket.end(`HTTP/1.1 302 Found\r\nLocation: ${origin}/redirect-target\r\nContent-Length: 0\r\n\r\n`); return; }
    if (state.mode === "stall") return;
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws, request));
  });
  sockets.on("connection", (socket: WebSocket, _request: IncomingMessage) => {
    socket.on("error", () => {});
    socket.on("message", (value, binary) => socket.send(value, { binary }));
    state.onSocket?.(socket);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new QCloud({ apiKey: "qc-secret-never-on-socket", baseURL: `${origin}/api/v1`, maxRetries: 3,
    defaultHeaders: { "X-Api-Secret": "not-for-websocket" } });
  return { id, token, origin, state, client, broadcast: (value: Uint8Array) => { for (const socket of sockets.clients) socket.send(value); }, close: async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    for (const socket of connections) socket.destroy();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test("raw Unicode and binary survive one capability/connection; API credentials never reach the socket", async () => {
  const f = await fixture();
  try {
    const socket = await f.client.generation.sessions.openSocket(f.id);
    await socket.send('{"text":"Καλημέρα 🌍"}'); assert.deepEqual(await socket.next(), { value: '{"text":"Καλημέρα 🌍"}', done: false });
    const binary = Uint8Array.from([0, 1, 128, 255]); await socket.send(binary);
    assert.deepEqual(await socket.next(), { value: binary, done: false });
    await Promise.all([socket.close(), socket.close()]);
    assert.equal(socket.closeResult?.billing.status, "pending");
    assert.deepEqual(await socket.next(), { value: undefined, done: true });
    assert.deepEqual([f.state.connects, f.state.upgrades, f.state.closes], [1, 1, 1]);
    assert.deepEqual(f.state.authorization, [undefined]);
    assert.equal(f.state.protocols[0], `qcloud.realtime.v1,qcloud.cap.${f.token}`);
  } finally { await f.close(); }
});

test("capability identity, origin, path, expiry and native protocol fail before any socket", async () => {
  const f = await fixture();
  try {
    const valid = `${f.origin.replace("http:", "ws:")}/v1/generation/sessions/${f.id}/socket`;
    const variants: Record<string, unknown>[] = [
      { session_id: randomUUID() }, { token: "A".repeat(42) }, { token: "A".repeat(42) + "B" },
      { websocket_url: "wss://foreign.example/v1/generation/sessions/" + f.id + "/socket" },
      { websocket_url: valid + "?token=hidden" }, { websocket_url: valid + "?" }, { websocket_url: valid + "#fragment" },
      { websocket_url: " " + valid }, { websocket_url: valid.replace("/v1/", "/extra/../v1/") },
      { websocket_url: valid.replace("/socket", "/another") }, { websocket_url: valid.replace("ws://", "ws://user:password@") },
      { subprotocols: ["qcloud.realtime.v1", "qcloud.cap.wrong"] }, { subprotocols: ["qcloud.realtime.v1"] },
      { expires_at: new Date(Date.now() - 10).toISOString() }, { expires_at: new Date(Date.now() + 120_000).toISOString() },
      { expires_at: "2026-02-30T00:00:00Z" },
      { transport: "webrtc", signaling: "websocket", protocol: "rtc-signaling-v1", encoding: "msgpack" },
    ];
    for (const value of variants) {
      const closes = f.state.closes;
      f.state.capability = value;
      await assert.rejects(f.client.generation.sessions.openSocket(f.id), Object.hasOwn(value, "session_id") ? APIResponseValidationError : GenerationSocketError);
      assert.equal(f.state.closes, closes + (Object.hasOwn(value, "session_id") ? 0 : 1));
    }
    assert.equal(f.state.upgrades, 0); assert.equal(f.state.connects, variants.length); assert.equal(f.state.closes, variants.length - 1);
  } finally { await f.close(); }
});

test("separate relay requires an explicit secure origin; capability tokens stay out of errors", async () => {
  const f = await fixture(), relay = await fixture();
  try {
    f.state.capability = { websocket_url: `${relay.origin.replace("http:", "ws:")}/v1/generation/sessions/${f.id}/socket` };
    await assert.rejects(f.client.generation.sessions.openSocket(f.id), (error: unknown) => error instanceof GenerationSocketError && !error.message.includes(f.token));
    assert.equal(relay.state.upgrades, 0);
    const socket = await f.client.generation.sessions.openSocket(f.id, { relayOrigin: relay.origin.replace("http:", "ws:") });
    await socket.send("hello"); assert.equal((await socket.next()).value, "hello"); await socket.close();
    assert.deepEqual(relay.state.authorization, [undefined]);
  } finally { await f.close(); await relay.close(); }
});

test("redirects and unexpected selected protocols never reconnect", async () => {
  for (const mode of ["redirect", "wrong-protocol"]) {
    const f = await fixture(); f.state.mode = mode;
    try {
      await assert.rejects(f.client.generation.sessions.openSocket(f.id), GenerationSocketError);
      assert.deepEqual([f.state.connects, f.state.upgrades, f.state.closes], [1, 1, 1]);
    } finally { await f.close(); }
  }
});

test("receive queues and frame sizes are bounded and trigger one durable close", async () => {
  for (const mode of ["queue", "message"]) {
    const f = await fixture();
    try {
      const socket = await f.client.generation.sessions.openSocket(f.id, { maxBufferedMessages: 1, maxBufferedBytes: 10, maxMessageBytes: 10 });
      f.state.onSocket = undefined;
      if (mode === "queue") { await socket.send("one"); await socket.send("two"); }
      else f.broadcast(new Uint8Array(11)); // Independent of outbound validation.
      await assert.rejects(socket.closed, (error: unknown) => error instanceof GenerationSocketError && error.code === (mode === "queue" ? "receive_buffer_exceeded" : "transport_failed"));
      await assert.rejects(socket.next(), GenerationSocketError); assert.equal(f.state.closes, 1);
    } finally { await f.close(); }
  }
});

test("outbound bounds and concurrent sends do not build an unbounded SDK queue", async () => {
  const f = await fixture();
  try {
    const socket = await f.client.generation.sessions.openSocket(f.id, { maxMessageBytes: 10, maxBufferedBytes: 10 });
    await assert.rejects(socket.send("🌍🌍🌍"), (error: unknown) => error instanceof GenerationSocketError && error.code === "send_buffer_exceeded");
    const pending = socket.send("ok");
    await assert.rejects(socket.send("also"), (error: unknown) => error instanceof GenerationSocketError && error.code === "concurrent_send");
    await pending; assert.equal((await socket.next()).value, "ok"); await socket.close(); assert.equal(f.state.closes, 1);
  } finally { await f.close(); }
});

test("abort and lifetime deadline stop the socket and request one close", async () => {
  for (const mode of ["abort", "deadline"]) {
    const f = await fixture(), controller = new AbortController();
    try {
      const socket = await f.client.generation.sessions.openSocket(f.id, { signal: controller.signal, maxDurationMs: mode === "deadline" ? 30 : 1000 });
      const read = socket.next(); if (mode === "abort") controller.abort();
      await assert.rejects(read, (error: unknown) => error instanceof GenerationSocketError && error.code === (mode === "abort" ? "aborted" : "duration_exceeded"));
      await assert.rejects(socket.close(), GenerationSocketError); assert.equal(f.state.closes, 1);
    } finally { await f.close(); }
  }
});

test("close failure stays distinct from the original transport failure and is not retried", async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const socket = await f.client.generation.sessions.openSocket(f.id, { signal: controller.signal }); f.state.closeFailure = true;
    controller.abort();
    await assert.rejects(socket.closed, (error: unknown) => error instanceof GenerationSocketError && error.code === "aborted" && error.closeError?.code === "session_close_unconfirmed");
    assert.equal(socket.closeError?.code, "session_close_unconfirmed"); assert.equal(f.state.closes, 1);
  } finally { await f.close(); }
});

test("breaking raw iteration closes ownership once", async () => {
  const f = await fixture();
  try {
    const socket = await f.client.generation.sessions.openSocket(f.id); await socket.send("one");
    for await (const value of socket) { assert.equal(value, "one"); break; }
    await socket.closed; assert.equal(f.state.closes, 1);
  } finally { await f.close(); }
});

test("stalled handshakes have bounded abort and timeout cleanup without reconnect", async () => {
  for (const mode of ["abort", "timeout"]) {
    const f = await fixture(), controller = new AbortController(); f.state.mode = "stall";
    try {
      const pending = f.client.generation.sessions.openSocket(f.id, { signal: controller.signal, openTimeoutMs: 200, closeTimeoutMs: 100 });
      // Attach immediately so the test never creates an unhandled rejection.
      const outcome = assert.rejects(pending, (error: unknown) => error instanceof GenerationSocketError && (mode !== "abort" || error.code === "aborted"));
      if (mode === "abort") {
        const deadline = Date.now() + 1000;
        while (f.state.upgrades === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
        assert.equal(f.state.upgrades, 1); controller.abort();
      }
      await outcome; assert.deepEqual([f.state.connects, f.state.upgrades, f.state.closes], [1, 1, 1]);
    } finally { await f.close(); }
  }
});

test("invalid local limits and an already-aborted signal never request a capability", async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(f.client.generation.sessions.openSocket(f.id, { maxBufferedMessages: 0 }), TypeError);
    await assert.rejects(f.client.generation.sessions.openSocket(f.id, { relayOrigin: "wss://relay.example/path" }), TypeError);
    await assert.rejects(f.client.generation.sessions.openSocket(f.id, { signal: controller.signal }));
    assert.deepEqual([f.state.connects, f.state.upgrades, f.state.closes], [0, 0, 0]);
  } finally { await f.close(); }
});
