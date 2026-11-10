// Background worker pattern for billable QCloud requests. Replace the array
// queue with BullMQ, SQS, a database table, etc. The billing rules are the same:
//  - 429 and 402 were rejected before provider work: re-enqueue after
//    retryAfter, or stop until credits are added.
//  - 400/404 will not succeed on retry: fail the job.
//  - APIConnectionError after sending, or a 5xx, is ambiguous: the provider may
//    have produced billable output. Mark for review; do not replay.
//
//   QCLOUD_API_KEY=... QCLOUD_MODEL=... node worker.mjs
import {
  APIConnectionError, APIError, BadRequestError, InsufficientCreditsError, NotFoundError, QCloud, RateLimitError,
} from "qcloud-ai";

const client = new QCloud({ timeout: 120_000, maxRetries: 2 }); // retries only safe cases
const model = process.env.QCLOUD_MODEL;
const queue = [
  { id: "job-0", prompt: "Name a prime number.", notBefore: 0, notes: [] },
  { id: "job-1", prompt: "Name a colour.", notBefore: 0, notes: [] },
];

async function process_(job) {
  try {
    const reply = await client.chat.completions.create({ model, max_tokens: 200, messages: [{ role: "user", content: job.prompt }] });
    return { ...job, state: "done", result: reply.choices[0].message.content };
  } catch (error) {
    if (error instanceof RateLimitError) {
      queue.push({ ...job, notBefore: Date.now() + (error.retryAfter ?? 5) * 1000, notes: [...job.notes, `rate limited ${error.requestID}`] });
      return null;
    }
    if (error instanceof InsufficientCreditsError) return { ...job, state: "blocked_on_credits", notes: [...job.notes, error.requestID] };
    if (error instanceof BadRequestError || error instanceof NotFoundError) return { ...job, state: "failed", notes: [...job.notes, error.message] };
    if (error instanceof APIError) return { ...job, state: "needs_review", notes: [...job.notes, `${error.status} ${error.requestID}`] };
    if (error instanceof APIConnectionError) return { ...job, state: "needs_review", notes: [...job.notes, error.name] };
    throw error;
  }
}

while (queue.length) {
  const job = queue.shift();
  const wait = job.notBefore - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 60_000)));
  const finished = await process_(job);
  if (finished) console.log(finished.id, finished.state, finished.result ?? finished.notes.join("; "));
}
