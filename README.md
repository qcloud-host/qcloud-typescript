<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/qcloud-host/qcloud-typescript/main/assets/qcloud-wordmark-light.svg">
  <img alt="QCloud" src="https://raw.githubusercontent.com/qcloud-host/qcloud-typescript/main/assets/qcloud-wordmark.svg" width="220">
</picture>

# QCloud TypeScript

A typed QCloud inference and generation client for Node.js 20+, with ESM and CommonJS builds and no runtime dependencies.

## Install

Until the first npm release, build and install the package from source:

```bash
git clone https://github.com/qcloud-host/qcloud-typescript.git
cd qcloud-typescript
npm ci
npm run check
npm pack
# In your application:
npm install /path/to/qcloud-ai-0.2.0.tgz
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

Breaking iteration closes the HTTP body. Call `await stream.abort()` to close a stream explicitly, including one you have not iterated. The configured timeout remains active until stream consumption ends.

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
import { APIError } from "qcloud-ai";
const client = new QCloud({ timeout: 120_000, maxRetries: 0 });
try {
  await client.models.list();
} catch (error) {
  if (error instanceof APIError) console.error(error.status, error.requestID);
  else throw error;
}
```

`apiKey` / `QCLOUD_API_KEY` is required. `baseURL` / `QCLOUD_BASE_URL` defaults to `https://platform.qcloud.host/api/v1`. For a separate backend deployment, set the full verified API URL including `/v1`; do not infer the API hostname from the website domain. `organization` / `QCLOUD_ORGANIZATION_ID` selects an organization UUID through `X-QCloud-Organization`; an API key can only select the organization that owns it. `timeout` is milliseconds per attempt, including stream delivery (default 600000). `maxRetries` defaults to 2. `defaultHeaders` adds headers and `fetch` injects a custom fetch transport. Request methods accept a second options argument with `signal` and `headers`. Browser execution is disabled to prevent embedding server API keys in client applications.

The SDK exports typed HTTP, authentication, billing, rate-limit, connection, timeout, and response-validation errors. Caller cancellation preserves the abort signal's reason.

## Use the official OpenAI SDK

```typescript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.QCLOUD_API_KEY,
  baseURL: "https://platform.qcloud.host/api/v1",
});
```

Use its Chat Completions API with an active QCloud model ID. See [OpenAI's API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Anthropic's distinct Messages protocol](https://platform.claude.com/docs/en/api/typescript/messages/create).

## Develop

```bash
npm ci
npm run check
npm pack --dry-run
```

See [examples](examples) for tools and JSON output. Tests inject local HTTP transports and make no paid model calls.

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
| Anthropic Messages                              | Backend compatibility endpoint; use the official Anthropic client |

Model availability and features are determined by the QCloud catalog and upstream provider. Use the QCloud model ID, which may differ from the provider's public model ID. The backend also supports `/messages` with Anthropic version `2023-06-01` for compatible text, image, and tool requests. This QCloud SDK has no `messages` resource; use the official Anthropic client with `baseURL: "https://platform.qcloud.host/api"` (it appends `/v1/messages`) and your QCloud key. Beta features and exact token counting are rejected, so this does not promise full Claude Code compatibility. This library is maintained by QCloud and is not an OpenAI or Anthropic product.

## Serverless queue drafts

`client.serverless.queue` saves planning records. It has no launch or job-execution method. A draft creates no endpoint, worker, billing account or charge. The catalog may be empty until an operator publishes reviewed profiles; `runtime_available` remains `false`, and `pricing: null` means unknown, never free.

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

## Reliability

Read-only GET requests retry connection failures, timeouts, HTTP 408/409/429 and 5xx responses up to twice, with backoff and `Retry-After` support. Inference POST requests retry only HTTP 429 rejections. An ambiguous connection failure, timeout or server error is surfaced without replaying a potentially billable generation. Authentication/billing failures and started streams are never retried. Set `maxRetries: 0` to disable all retries. A manual retry after an ambiguous failure may incur duplicate usage.

Streaming handles fragmented UTF-8, CRLF/LF events, multiple data lines, error payloads, and `[DONE]`. A connection ending without `[DONE]` raises a response-validation error instead of reporting a truncated response as complete. HTTP errors are checked before returning a stream; HTTP and streamed API errors retain the server request ID. Invalid JSON or an HTML response from a misconfigured endpoint produces a typed error.

## Security and support

Keep `QCLOUD_API_KEY` in a server environment variable, never in browser code, source control, or a public notebook. Use `QCLOUD_BASE_URL` only for endpoints you trust. HTTPS is the production default; HTTP is supported for local testing. Redirects are not followed. An API key, an active catalog model, and a working QCloud inference backend are required for live requests.

[QCloud](https://www.qcloud.host) · [Developer quickstart](https://www.qcloud.host/api-docs) · [Contact](mailto:info@qcloud.host)

MIT licensed. See [LICENSE](LICENSE).
