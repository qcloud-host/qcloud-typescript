import QCloud from "qcloud-ai";

const model = process.env.QCLOUD_MODEL;
if (!model) throw new Error("Set QCLOUD_MODEL to an active QCloud catalog ID");

const controller = new AbortController();
const cancelled = new Error("Stopped by the user");
const stop = () => controller.abort(cancelled);
process.once("SIGINT", stop);
let stream;
try {
  stream = await new QCloud().chat.completions.create({
    model,
    messages: [{ role: "user", content: "Explain how a rainbow forms." }],
    stream: true,
    max_tokens: 256,
  }, { signal: controller.signal, timeout: 60_000 });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta.content ?? "");
    // A `break` here also closes the stream's HTTP response.
  }
  process.stdout.write("\n");
} catch (error) {
  if (error === cancelled) console.error("\nStopped reading the response.");
  else throw error;
} finally {
  process.off("SIGINT", stop);
  await stream?.abort();
}
// Cancellation closes the connection; it does not establish zero usage or a refund.
