import QCloud, {
  APIConnectionError,
  APIError,
  APITimeoutError,
  InsufficientCreditsError,
  RateLimitError,
} from "qcloud-ai";

const model = process.env.QCLOUD_MODEL;
if (!model) throw new Error("Set QCLOUD_MODEL to an active QCloud catalog ID");
const client = new QCloud({ timeout: 60_000, maxRetries: 2 });

try {
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Explain HTTP retries in one sentence." }],
    max_tokens: 128,
  });
  console.log(completion.choices[0]?.message.content);
  console.log("Reported token usage:", completion.usage);
} catch (error) {
  // SDK retries are bounded. There is deliberately no second retry loop here:
  // an ambiguous failed POST may already have produced billable output.
  if (error instanceof RateLimitError) {
    console.error("Admission limit reached", {
      requestID: error.requestID,
      retryAfterSeconds: error.retryAfter,
      rateLimit: error.rateLimit,
    });
  } else if (error instanceof InsufficientCreditsError) {
    console.error("Check available credits in the QCloud console", error.requestID);
  } else if (error instanceof APITimeoutError || error instanceof APIConnectionError) {
    console.error("Request outcome may be unknown. Check usage before retrying.");
  } else if (error instanceof APIError) {
    // Keep the request ID for support. Avoid logging prompts, keys or response bodies.
    console.error({ status: error.status, code: error.code, requestID: error.requestID });
  } else {
    throw error;
  }
  process.exitCode = 1;
}
