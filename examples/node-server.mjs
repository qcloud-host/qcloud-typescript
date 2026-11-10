// Plain Node.js HTTP service that calls QCloud. The same handlers work in
// Express or Fastify. The QCloud key stays on the server; one client per
// process reuses pooled connections.
//
//   npm install qcloud-ai
//   QCLOUD_API_KEY=... QCLOUD_MODEL=<active id> node node-server.mjs
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { APIConnectionError, APIError, QCloud, RateLimitError } from "qcloud-ai";

const client = new QCloud({ timeout: 120_000 });
const model = process.env.QCLOUD_MODEL;

async function readMessage(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return String(JSON.parse(raw || "{}").message ?? "");
}

function sendError(res, error) {
  if (error instanceof APIError) {
    const status = [400, 402, 404, 429].includes(error.status) ? error.status : 502;
    const headers = { "content-type": "application/json", "x-qcloud-request-id": error.requestID ?? "" };
    if (error instanceof RateLimitError && error.retryAfter !== undefined) headers["retry-after"] = String(Math.ceil(error.retryAfter));
    res.writeHead(status, headers).end(JSON.stringify({ error: error.message, code: error.code }));
  } else if (error instanceof APIConnectionError) {
    // The provider may have started: do not replay automatically.
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "Upstream unavailable; check usage before retrying" }));
  } else {
    res.writeHead(500).end();
  }
}

export const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/chat") {
      const reply = await client.chat.completions.create({ model, messages: [{ role: "user", content: await readMessage(req) }] });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply: reply.choices[0].message.content, usage: reply.usage }));
    } else if (req.method === "POST" && req.url === "/chat/stream") {
      // Aborting on client disconnect closes the QCloud stream and the provider request.
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const stream = await client.chat.completions.create(
        { model, messages: [{ role: "user", content: await readMessage(req) }], stream: true },
        { signal: abort.signal },
      );
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta.content;
        if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    if (res.headersSent) res.destroy(); // a broken stream must not look complete
    else sendError(res, error);
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(Number(process.env.PORT ?? 3000), () => console.log("listening"));
}
