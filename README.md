<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/qcloud-host/qcloud-typescript/main/assets/qcloud-wordmark-light.svg">
  <img alt="QCloud" src="https://raw.githubusercontent.com/qcloud-host/qcloud-typescript/main/assets/qcloud-wordmark.svg" width="220">
</picture>

# QCloud TypeScript

A typed QCloud inference client for Node.js 20+, with ESM and CommonJS builds and no runtime dependencies.

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

`apiKey` / `QCLOUD_API_KEY` is required. `baseURL` / `QCLOUD_BASE_URL` defaults to `https://www.qcloud.host/api/v1`. `timeout` is milliseconds per attempt, including stream delivery (default 600000). `maxRetries` defaults to 2. `defaultHeaders` adds headers and `fetch` injects a custom fetch transport. Request methods accept a second options argument with `signal` and `headers`. Browser execution is disabled to prevent embedding server API keys in client applications.

The SDK exports typed HTTP, authentication, billing, rate-limit, connection, timeout, and response-validation errors. Caller cancellation preserves the abort signal's reason.

## Use the official OpenAI SDK

```typescript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.QCLOUD_API_KEY,
  baseURL: "https://www.qcloud.host/api/v1",
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

| Resource                                         | Support                                                     |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Chat Completions                                 | Text, streaming, tool-call and structured-output parameters |
| Models                                           | List and retrieve catalog entries                           |
| Embeddings                                       | Create embeddings with a supported model                    |
| Legacy Completions                               | Available when the selected provider/model supports it      |
| OpenAI Responses, files, audio, realtime         | Not exposed by this SDK/backend release                     |
| Native Anthropic Messages / Claude Code protocol | Not exposed by the current QCloud backend                   |

Model availability and features are determined by the QCloud catalog and upstream provider. Use the QCloud model ID, which may differ from the provider's public model ID. Claude-family models can use Chat Completions when listed in QCloud; the native Anthropic SDK cannot simply be pointed at this endpoint. This library is maintained by QCloud and is not an OpenAI or Anthropic product.

## Reliability

Connection failures, timeouts, HTTP 408/409/429 and 5xx responses are retried twice by default, with backoff and `Retry-After` support. Authentication/billing failures are not retried. Once stream delivery begins, the SDK never replays the request. Retrying a generation may incur duplicate usage if a server processed the first attempt; disable retries for strict single-attempt behavior.

Streaming handles fragmented UTF-8, CRLF/LF events, multiple data lines, error payloads, and `[DONE]`. HTTP errors are checked before returning a stream. Invalid JSON or an HTML response from a misconfigured endpoint produces a typed error.

## Security and support

Keep `QCLOUD_API_KEY` in a server environment variable, never in browser code, source control, or a public notebook. Use `QCLOUD_BASE_URL` only for endpoints you trust. HTTPS is the production default; HTTP is supported for local testing. Redirects are not followed. An API key, an active catalog model, and a working QCloud inference backend are required for live requests.

[QCloud](https://www.qcloud.host) · [Developer quickstart](https://www.qcloud.host/api-docs) · [Contact](mailto:info@qcloud.host)

MIT licensed. See [LICENSE](LICENSE).
