// Next.js App Router route handler: app/api/chat/route.ts
// The QCloud key is read on the server only. Never expose it through a
// NEXT_PUBLIC_* variable; the SDK refuses to run in a browser.
import { APIConnectionError, APIError, QCloud, RateLimitError, type ChatCompletionChunk, type Stream } from "qcloud-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = new QCloud({ timeout: 120_000 });

function errorResponse(error: unknown): Response {
  if (error instanceof APIError) {
    const status = [400, 402, 404, 429].includes(error.status) ? error.status : 502;
    const headers: Record<string, string> = { "x-qcloud-request-id": error.requestID ?? "" };
    if (error instanceof RateLimitError && error.retryAfter !== undefined) headers["retry-after"] = String(Math.ceil(error.retryAfter));
    return Response.json({ error: error.message, code: error.code }, { status, headers });
  }
  if (error instanceof APIConnectionError)
    return Response.json({ error: "Upstream unavailable; check usage before retrying" }, { status: 503 });
  throw error;
}

/** POST { message } → text/event-stream of { text } events. */
export async function POST(request: Request): Promise<Response> {
  const { message } = (await request.json()) as { message?: string };
  let stream: Stream<ChatCompletionChunk>;
  try {
    // request.signal aborts when the browser disconnects; QCloud then aborts the provider call.
    stream = await client.chat.completions.create(
      { model: process.env.QCLOUD_MODEL!, messages: [{ role: "user", content: String(message ?? "") }], stream: true },
      { signal: request.signal },
    );
  } catch (error) {
    return errorResponse(error);
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta.content;
          if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error); // a broken stream must not look complete
      }
    },
    async cancel() {
      await stream.abort();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
