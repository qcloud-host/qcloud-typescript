// Anthropic-style Messages through QCloud (supported subset).
//   QCLOUD_API_KEY=... QCLOUD_MODEL=... node messages.mjs
import { QCloud, messageText } from "qcloud-ai";

const client = new QCloud();
const model = process.env.QCLOUD_MODEL;
const message = await client.messages.create({
  model,
  max_tokens: 256,
  system: "Answer in one sentence.",
  messages: [{ role: "user", content: "What is an embedding?" }],
});
console.log(messageText(message));
console.log("usage:", message.usage.input_tokens, message.usage.output_tokens);

const stream = await client.messages.create({ model, max_tokens: 256, stream: true, messages: [{ role: "user", content: "Count to five." }] });
for await (const event of stream) {
  if (event.type === "content_block_delta") process.stdout.write(String(event.delta?.text ?? ""));
  else if (event.type === "message_delta") console.log("\nusage:", JSON.stringify(event.usage));
}
