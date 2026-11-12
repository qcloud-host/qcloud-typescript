<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/qcloud-host/qcloud-typescript/main/assets/qcloud-wordmark-light.svg">
  <img alt="QCloud" src="https://raw.githubusercontent.com/qcloud-host/qcloud-typescript/main/assets/qcloud-wordmark.svg" width="220">
</picture>

# QCloud TypeScript

A typed QCloud inference and generation client for Node.js 20+, with ESM and CommonJS builds. Native WebSocket sessions use the pinned `ws` runtime dependency.

## Install

Until the first npm release, build and install the package from source:

```bash
git clone https://github.com/qcloud-host/qcloud-typescript.git
cd qcloud-typescript
npm ci
npm run check
npm pack
# In your application:
npm install /path/to/qcloud-ai-0.4.0.tgz
```

The prepared npm package is named `qcloud-ai`. Registry publication is a separate release step.

## First request

Set `QCLOUD_API_KEY` and choose `QCLOUD_MODEL` from the active QCloud model catalog.

```typescript
import QCloud from "qcloud-ai";

const client = new QCloud();
const model = process.env.QCLOUD_MODEL;
if (!model) throw new Error("Set QCLOUD_MODEL to an active catalog ID");
const response = await client.chat.completions.create({
  model,
  messages: [
    { role: "user", content: "Explain vector search in one paragraph." },
  ],
});
console.log(response.choices[0].message.content);
```

Named imports `QCloud` and `QCloudAI` are also available. CommonJS: `const { QCloud } = require('qcloud-ai')`.

## Streaming and cancellation

```typescript
const controller = new AbortController();
const stream = await client.chat.completions.create(
  {
    model,
    messages: [{ role: "user", content: "Write a short story." }],
    stream: true,
  },
  { signal: controller.signal },
);

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}
```

Breaking iteration closes the HTTP body. Call `await stream.abort()` to close a stream explicitly, including one you have not iterated. The configured timeout remains active until stream consumption ends, including pauses in your consumer. Cancellation stops buffered events from being delivered after the next yield. See [the runnable Ctrl+C example](examples/stream-and-cancel.mjs) for cleanup with `try/finally`. Closing the connection does not prove zero usage or a refund.

## Models and embeddings

```typescript
const models = await client.models.list();
for (const model of models.data) console.log(model.id);
const embeddingModel = process.env.QCLOUD_EMBEDDING_MODEL;
if (!embeddingModel) throw new Error("Set QCLOUD_EMBEDDING_MODEL");
const result = await client.embeddings.create({
  model: embeddingModel,
  input: ["Search this document"],
});
console.log(result.data[0].embedding);
```

Embedding requests accept `dimensions` and `encoding_format` when supported by the selected model. The default float encoding returns a number array; explicitly selecting `base64` returns a string. The backend rejects unsupported routing/add-on options and checks model capabilities before dispatch.

## Configuration and errors

```typescript
import { APIError, BadRequestError, InsufficientCreditsError, RateLimitError } from "qcloud-ai";
const client = new QCloud({ timeout: 120_000, maxRetries: 0 });
try {
  await client.chat.completions.create({ model: process.env.QCLOUD_MODEL!, messages });
} catch (error) {
  // Rate-limit values describe QCloud admission, not a provider's final charge.
  if (error instanceof RateLimitError) console.error(error.retryAfter, error.rateLimit, error.requestID);
  else if (error instanceof InsufficientCreditsError) console.error("Top up credits", error.requestID);
  else if (error instanceof BadRequestError) console.error("Rejected before dispatch", error.code, error.message);
  else if (error instanceof APIError) console.error(error.status, error.errorType, error.code, error.requestID);
  else throw error;
}
```

`apiKey` / `QCLOUD_API_KEY` is required. `baseURL` / `QCLOUD_BASE_URL` defaults to `https://platform.qcloud.host/api/v1`. For a separate backend deployment, set the full verified API URL including `/v1`; do not infer the API hostname from the website domain. `organization` / `QCLOUD_ORGANIZATION_ID` selects an organization UUID through `X-QCloud-Organization`; an API key can only select the organization that owns it. `timeout` is milliseconds per attempt, including stream delivery (default 600000). `maxRetries` defaults to 2. `defaultHeaders` adds headers and `fetch` injects a custom fetch transport. Request methods accept a second options argument with `signal` and `headers`. Browser execution is disabled to prevent embedding server API keys in client applications.

Every HTTP error subclasses `APIError`: `BadRequestError` (400), `AuthenticationError` (401), `InsufficientCreditsError` (402), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `UnprocessableEntityError` (422), `RateLimitError` (429) and `InternalServerError` (5xx). Each carries `requestID` (quote it to support), `headers`, `retryAfter` in seconds, `rateLimit` (`limitRequests`, `remainingRequests`, `limitTokens`, `remainingTokens`), `errorType` and `code`. Network failures raise `APIConnectionError` or `APITimeoutError`. Caller cancellation preserves the abort signal's reason. The full matrix is in [COMPATIBILITY.md](COMPATIBILITY.md).

## Anthropic-style Messages

`client.messages` calls QCloud's Messages bridge with the same key and base URL. It supports text, system prompts, images for `vision` models and function tools. Thinking, prompt caching, beta headers, documents, server tools, `top_k` and non-empty `stop_sequences` fail with `BadRequestError` before dispatch, and exact token counting is not available. It is not a Claude Code gateway.

```typescript
import { QCloud, messageText } from "qcloud-ai";
const client = new QCloud();
const message = await client.messages.create({
  model: process.env.QCLOUD_MODEL!,
  max_tokens: 256,
  system: "Answer in one sentence.",
  messages: [{ role: "user", content: "What is an embedding?" }],
});
console.log(messageText(message), message.usage);

const stream = await client.messages.create({ model: process.env.QCLOUD_MODEL!, max_tokens: 256, stream: true,
  messages: [{ role: "user", content: "Count to five." }] });
for await (const event of stream) {
  if (event.type === "content_block_delta") process.stdout.write(String(event.delta?.text ?? ""));
}
```

The stream ends at `message_stop`; the preceding `message_delta` carries exact usage. A stream that ends earlier throws `APIResponseValidationError`.

## Use the official OpenAI SDK

```typescript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.QCLOUD_API_KEY,
  baseURL: "https://platform.qcloud.host/api/v1",
  maxRetries: 0, // its default retries can replay an ambiguous, billable POST
});
```

Use its Chat Completions API with an active QCloud model ID. The official Anthropic SDK works with `baseURL: "https://platform.qcloud.host/api"` (no `/v1`) for the supported Messages subset. Both are covered by contract tests with pinned versions. See [OpenAI's API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Anthropic's distinct Messages protocol](https://platform.claude.com/docs/en/api/typescript/messages/create).

## Develop

```bash
npm ci
npm run check
npm run check:package
```

See [the examples guide](examples/README.md) for environment setup on macOS/Linux and PowerShell, streaming cancellation, error handling, tools, JSON output, Messages, a Node.js HTTP service, a Next.js route handler and a background worker. Tests inject local HTTP transports and make no paid model calls. The package check runs on Windows as well as Linux without invoking a command shell.

## API coverage

`client.generation.models.list()`, `.retrieve(id)`, and `.schema(id)` discover the
generation catalog and its captured per-model references. `client.generation.jobs`
supports `submit`, `retrieve`, `result`, `cancel`, `wait`, and `subscribe` for any
schema-defined JSON input/output on queued models. Catalog models expose
`transport`, `queued_available`, and `schema_available`. Check
`queued_available` before submitting; WebSocket, WebRTC, and unknown transports
require separate session support and cannot run through these job helpers.

```typescript
const completed = await client.generation.jobs.subscribe({
  model: process.env.QCLOUD_GENERATION_MODEL!,
  input: JSON.parse(process.env.QCLOUD_GENERATION_INPUT!),
  billing_mode: "metered",
  client_request_id: crypto.randomUUID(), // Persist with the original input.
}, { timeoutMs: 600_000, pollIntervalMs: 1_000 });
console.log(completed.result.data);
```

Metered submission explicitly accepts variable charges; there is no guaranteed
spending-cap field. Generation POSTs are never automatically replayed. Reuse the
same UUID and identical body after an ambiguous failure. Typed submission errors
retain `clientRequestId`. `GenerationJobError` carries the failed/cancelled/review
job; `GenerationTimeoutError` retains `jobId`. AbortSignal or a polling timeout
stops the client only; call `jobs.cancel(id)` explicitly for best-effort server
cancellation. `result(id)` returns a final `{job_id,data,billing}` or pending
`{data:job}` response. New catalog models do not require an SDK update.

Catalog models include `reference_status` (`current`, `retained`, or `unavailable`),
`reference_stale`, and separate `reference_updated_at` / `reference_checked_at`
timestamps. A retained contract keeps its original capture date and creator/license
notices; it is historical documentation, and cannot start new jobs or sessions.
`catalog.degraded` and `catalog.quarantined_count` report affected models while
healthy references continue to refresh. Require `queued_available: true` before
submitting a queued job. `renderGenerationModelReference` omits runnable examples
when either model metadata or the schema marks the reference historical, stale,
or unavailable for execution.
Older snapshots may omit these fields; omission does not establish availability.

When present, `admission_policy` adds current request restrictions to the complete
model schema. Follow both: a schema can describe settings the service does not
currently accept. The policy lists required fields, permitted values and whether
extra fields are allowed. `availability_reason` explains a model's policy
restriction. Reservations are review thresholds, not guaranteed spending caps;
current prices, billing eligibility and account limits are checked at submission.

### Upload local model inputs

```ts
const inputFile = await client.generation.files.upload({ path: "input.png" }, {
  contentType: "image/png", maxBytes: 32 * 1024 * 1024,
});
// Use this reference in the field required by your chosen model's schema:
const modelInput = { image_url: inputFile.url };
```

`upload` accepts `Uint8Array`/`Buffer`, `{path: "local/file"}`, or an async byte
iterable (including Node readable streams). Paths must be regular files; URLs
are rejected. Bytes and streams default to `filename: "upload.bin"`; override it
with a basename and set `contentType` to a bare MIME type (normalized to lowercase).
No multipart or base64
encoding is needed. The SDK streams chunks of at most 64 KiB and verifies the
returned size and SHA-256. It never buffers the whole file.

`maxBytes` defaults to 256 MiB. The backend's configured limit may be lower
(default 64 MiB); this option cannot raise it. `size` optionally declares an
exact stream length. `timeout` defaults to 120000 milliseconds across source,
request and response delivery; `signal` cancels the request. SDK-opened files
are closed; supplied stream iterators receive `return()` on exit and should
cooperate with cancellation. Uploads never retry, including after partial
delivery. A lost response may have left an uploaded file; do not assume failure
means nothing was stored.

The returned `GenerationUploadedFile` contains `id`, `url`, `filename`,
`content_type`, `size_bytes`, `sha256`, `created_at`, and `expires_at`.
Its `qcloud://files/<UUID>` URL is an opaque private input reference. QCloud
validates your organization's access and resolves it when dispatching a queued job.
Native WebSocket/WebRTC messages do not resolve these references.
It is not a browser URL or a provider credential. Expiry limits the QCloud
reference's lifetime, not a guarantee of physical deletion from upstream storage.
Underlying processing storage uses unguessable, publicly readable CDN links.
Private QCloud references and access checks do not make those objects private;
anyone who obtains an upstream link can read its file.
The backend must enable uploads and your key needs `generation:invoke`.
Uploading alone does not submit a model job or enable generation.

Read an upload's metadata later using its saved UUID:

```ts
const metadata = await client.generation.files.retrieve(inputFile.id);
console.log(metadata.filename, metadata.size_bytes, metadata.expires_at);
```

This requires `generation:read` in the same organization and returns a validated
`GenerationUploadedFile`, not file bytes. Pass a UUID, never a returned URL.
Missing or foreign uploads return `NotFoundError`; an expired upload returns
`APIError` with `status === 410`. The stored SHA-256 describes the uploaded bytes;
a metadata read does not download and hash them again. Standard request options
include `signal` and `timeout` (milliseconds).

### Download generated files

Generated media URLs require your QCloud key. Use the job UUID and the final asset
UUID in that URL with `client.generation.files.download(jobId, assetId)`; the SDK
constructs the route on its configured API origin. It never fetches an arbitrary
returned URL or follows a redirect with your key.

```ts
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// This model's result contains images[].url. Other model schemas may differ.
const result = completed.result;
const imageOutput = result.data as { images: Array<{ url: string }> };
const mediaUrl = new URL(imageOutput.images[0].url);
const assetId = mediaUrl.pathname.split("/").at(-1)!;
const jobId = result.job_id;
const file = await client.generation.files.download(jobId, assetId, {
  maxBytes: 64 * 1024 * 1024,
  timeout: 120_000,
});
try {
  // wx refuses to overwrite an existing file. Choose the path yourself.
  await pipeline(Readable.from(file), createWriteStream("output.bin", { flags: "wx" }));
} finally {
  await file.close();
}
```

The single-use async iterable yields binary chunks of at most 64 KiB. It exposes
`contentType`, `contentLength`, `contentRange`, `acceptRanges`, `status`,
`requestID`, and `bytesRead`; it does not derive a filename or write files itself.
`maxBytes` defaults to 256 MiB and can be lowered. `range: "bytes=0-1023"` requests
one byte range; inspect `status` and `contentRange` because a server can ignore a
range. `timeout` covers headers, body delivery and consumer pauses. Pass `signal`
to cancel; breaking iteration or `close()` releases the response. Downloads never
retry automatically, including after partial delivery. An error may leave a
partial file in caller-owned output; decide whether to retain or remove it.

`renderGenerationModelReference(model, schema)` generates a Markdown reference
with generic examples, exact OpenAPI or AsyncAPI component references, and license notices.
`schema_format` identifies the reference format; `reference_updated_at` dates its
capture independently of the catalog refresh. `schema_issues` reports missing
definitions or negotiation contracts without implying an enabled session route.

`client.generation.sessions.create/retrieve/connect/close` manage explicitly
enabled WebSocket/WebRTC sessions. Creation requires metered consent, transport,
and a stable UUID; `max_duration_seconds` defaults to 300. `connect` returns a
single-use capability, not an open socket. Keep tokens/subprotocols in memory
and use the returned `encoding` for native frames. Never reconnect or replay
frames automatically. Check `signaling` as well as `transport`: a WebRTC
capability with `signaling: "websocket"` has `websocket_url`, `subprotocols`,
`encoding: "msgpack"`, and `protocol: "rtc-signaling-v1"`. Use that socket for
the model's signaling messages and a separate peer connection for media. Close
both together and request `sessions.close(id)` during cleanup. Socket closure
alone does not prove remote media stopped or billing was settled. The SDK
returns the typed capability; it does not create or manage media peers.

For `transport: "webrtc"` with `signaling: "sse"` (or the legacy omitted field),
`sessions.offer(id, {type:"offer", sdp}, {sessionToken})`
returns a WebRTC signaling async iterable; keep it open for the session lifetime
and call `.close()` or break iteration to release it. Use a direct backend base
URL for long-lived connections. Unexpected EOF and streamed errors are surfaced;
retrieve session status for billing. Real-time availability requires a configured,
verified backend transport and is separate from catalog presence.

| Resource                                         | Support                                                     |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Chat Completions                                 | Text, streaming, tool-call and structured-output parameters |
| Models                                           | List and retrieve catalog entries                           |
| Embeddings                                       | Create embeddings with a supported model                    |
| Legacy Completions                               | Available when the selected provider/model supports it      |
| Generation models and jobs                      | Schema discovery, arbitrary JSON, durable jobs and polling |
| Generated files                                 | Authenticated binary streaming and single byte ranges       |
| OpenAI Responses, files, audio, realtime         | Not exposed by this SDK/backend release                     |
| Anthropic Messages                              | `client.messages`; supported text, image, tool and streaming subset |

Model availability and features are determined by the QCloud catalog and upstream provider. Use the QCloud model ID, which may differ from the provider's public model ID. The SDK's `client.messages` resource sets Anthropic version `2023-06-01` for compatible text, image, and tool requests. You may also use the official Anthropic client with `baseURL: "https://platform.qcloud.host/api"` (it appends `/v1/messages`) and your QCloud key. Beta features and exact token counting are rejected, so this does not promise full Claude Code compatibility. This library is maintained by QCloud and is not an OpenAI or Anthropic product.

## Serverless queue drafts

`client.serverless.queue.deployments` saves planning records. A draft creates no endpoint, worker, billing account or charge. The catalog may be empty until an operator publishes reviewed profiles; `runtime_available` remains `false`, and `pricing: null` means unknown, never free.

```ts
import { randomUUID } from "node:crypto";
const catalog = await client.serverless.queue.catalog();
if (catalog.creation_available) {
  const requestId = randomUUID(); // Persist with your intent before sending.
  const draft = await client.serverless.queue.deployments.create({
    name: "My model draft", profile_id: catalog.profiles[0].id,
    client_request_id: requestId,
  });
  console.log(await client.serverless.queue.deployments.retrieve(draft.id));
  console.log((await client.serverless.queue.deployments.list()).data);
}
```

Use a scoped QCloud key: `serverless:read` for catalog/list/retrieve and `serverless:manage` for creation. Optional `org_id` selects only the key's own organization; it cannot grant access to another tenant. Methods accept normal request options, including timeout and `AbortSignal` (retrieve takes options as its third argument).

Create makes one HTTP attempt, even when client retries are enabled. If omitted, the SDK generates `client_request_id` and attaches it as `error.clientRequestId` to typed API, connection and response-validation errors. After an ambiguous response, explicitly reuse that UUID with the identical name, profile and organization; the server returns the same draft. Changed intent or actor with the same UUID conflicts. For durable recovery across process termination, generate and store the UUID yourself before calling. QCloud deployment UUIDs are validated, and responses expose only the public draft fields. See [the draft example](examples/queue-draft.ts).

## Queue runtime (inactive)

The additive `client.serverless.queue.runtime` namespace exposes `capabilities()`, endpoint `quote`, `launch`, `list`, `retrieve`, `stop`, and job `quote`, `create`, `list`, `retrieve`, `result`. Public capabilities currently return `stage: "inactive"`, `execution_available: false`, and `billing_available: false`. Installing this SDK does not enable execution. Quote issuance requires a server-approved profile and metered billing eligibility; prepaid queue admission is not supported by this release.

```ts
const runtime = client.serverless.queue.runtime;
console.log(await runtime.capabilities());
const page = await runtime.endpoints.list({ limit: 20 });
for (const endpoint of page.items) console.log(endpoint.id, endpoint.state);
// Use both cursor fields together for a subsequent page:
if (page.next_cursor) {
  await runtime.endpoints.list({
    after_created_at: page.next_cursor.created_at, after_id: page.next_cursor.id,
  });
}
```

In an authorized environment, persist a request UUID, then call `endpoints.quote(draftId, { client_request_id })` or `jobs.quote(endpointId, { client_request_id, input: { prompt, max_tokens } })`. A quote creates no worker, model request or funds reservation. Its `estimated_cost_usd` is an exact six-decimal string; `is_spending_cap` is always `false`. Replaying the same intent returns the original quote, even after its `expires_at`; use a new UUID to request a new quote. Do not convert the estimate to a binary float for accounting.

Launch with `endpoints.launch(draftId, { quote_id: quote.id, client_request_id: quote.client_request_id })` or submit with `jobs.create(endpointId, { quote_id: quote.id, client_request_id: quote.client_request_id, input })`, preserving the quoted input and organization. Quote, launch, job submission and stop each make one HTTP attempt. Persist the UUID and full intent before sending. An ambiguous failure retains `error.clientRequestId`; an explicit replay must reuse the same UUID and intent. Stop reports authoritative `financial_exposure` separately from `released`; a repeated cancellation may return `false` / `"none"`. A stop request does not itself prove provider cleanup or a refund.

Lists return `{ items, next_cursor }` with `limit` from 1 to 50 (default 20). `retrieve` returns the requested public record. `jobs.result(endpointId, jobId)` returns `{ available: false }` until a validated result is available; then it includes `text`, `finish_reason`, and token `usage`. `requires_review` and held exposure may persist after an ambiguous operation. Resource UUIDs, response identity, cursor consistency, UTF-8 prompt/result bounds and usage totals are validated; private provider fields are omitted. Prompt limits are 1–16,384 UTF-8 bytes, and `max_tokens` is 1–4,096; an immutable server profile may impose smaller limits. Existing queue draft methods remain unchanged.

## Reliability

Read-only GET requests retry connection failures, timeouts, HTTP 408/409/429 and 5xx responses up to twice, with backoff and `Retry-After` support (up to 60 seconds). POST requests retry HTTP 429 admission rejections and connection failures that happened before the request was sent (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, connect timeout). A timeout, reset or server error after a POST was sent is surfaced without replaying it, because a provider may already have produced billable output; QCloud keeps that reservation for reconciliation. Set `maxRetries: 0` to disable all retries. Where an endpoint accepts `client_request_id`, reuse the same value to retry safely.

### Native generation sockets

For an explicitly enabled `transport: "websocket"` generation session, source
versions with this helper expose `client.generation.sessions.openSocket(id)`.
It returns a raw text/`Uint8Array` async iterator with `send`, `close`, `closed`,
`encoding` and `closeResult`. Encode the model's JSON or MessagePack messages
explicitly; the SDK does not create a WebRTC media peer.

```ts
const socket = await client.generation.sessions.openSocket(session.id, {
  signal: abortController.signal,
});
try {
  await socket.send(encodedModelInput); // string or Uint8Array
  for await (const frame of socket) consumeModelFrame(frame);
} finally {
  await socket.close();
}
```

The default relay origin is the configured QCloud API origin. A separate trusted
QCloud relay requires an explicit bare `relayOrigin` such as `wss://api.example.com`.
Credentials, query tokens, foreign origins and unexpected session paths are
rejected. API headers are never forwarded to the socket. There is one capability
request and one connection, with no automatic retries, reconnects or frame replay.

By default, each message and the total pending receive payload are limited to
16 MiB, with at most 16 queued messages and one outbound send in flight. Handshake
and send timeouts are 10 seconds, close timeout 5 seconds, and client lifetime at
most one hour. Options may narrow these ceilings. Aborting, leaving iteration,
transport failure or expiry closes the socket and requests HTTP session closure
once. `GenerationSocketError.closeError` preserves an additional cleanup failure;
`closeResult.billing` remains authoritative. Closing is not proof of zero cost
or confirmed remote billing teardown. These source additions do not activate a
model or publish a new package. See [native session boundaries](https://qcloud.host/api-docs).

Authentication/billing failures and started streams are never retried. A manual retry after an ambiguous failure may incur duplicate usage. The [error-handling example](examples/errors-and-retries.mjs) shows how to retain request IDs and admission limits without adding a second retry loop.

Streaming handles fragmented UTF-8, CRLF/LF events, multiple data lines, error payloads, and `[DONE]`. A connection ending without `[DONE]` raises a response-validation error instead of reporting a truncated response as complete. HTTP errors are checked before returning a stream; HTTP and streamed API errors retain the server request ID. Invalid JSON or an HTML response from a misconfigured endpoint produces a typed error.

## Security and support

Keep `QCLOUD_API_KEY` in a server environment variable, never in browser code, source control, or a public notebook. Use `QCLOUD_BASE_URL` only for endpoints you trust. HTTPS is the production default; HTTP is supported for local testing. Redirects are not followed. An API key, an active catalog model, and a working QCloud inference backend are required for live requests.

[QCloud](https://www.qcloud.host) · [Developer quickstart](https://www.qcloud.host/api-docs) · [Contact](mailto:info@qcloud.host)

MIT licensed. See [LICENSE](LICENSE).
