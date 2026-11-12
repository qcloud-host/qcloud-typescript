# QCloud Node.js examples

These examples use Node.js 20+. The new cancellation and error examples use the public `qcloud-ai` exports. From a source
checkout, run `npm ci` and `npm run build` first; Node resolves the package's
self-reference to the built files. See the [installation guide](../README.md#install)
to install the archive in another application.

Set the API key in your server environment and choose an active catalog model.
Never put your key into browser JavaScript or commit it to source control.

```bash
export QCLOUD_API_KEY="your-QCloud-key"
export QCLOUD_MODEL="your-active-model-id"
node examples/quickstart.mjs
```

PowerShell:

```powershell
$env:QCLOUD_API_KEY = "your-QCloud-key"
$env:QCLOUD_MODEL = "your-active-model-id"
node examples/quickstart.mjs
```

Live examples submit real requests and can incur usage. Choose a model returned
by `await client.models.list()` that supports the features in your example;
catalog membership alone does not establish account access or available capacity.

| Example | What it demonstrates |
| --- | --- |
| [quickstart.mjs](quickstart.mjs) | Model catalog discovery and one streamed chat request |
| [stream-and-cancel.mjs](stream-and-cancel.mjs) | Streaming text, Ctrl+C cancellation, timeout and cleanup |
| [errors-and-retries.mjs](errors-and-retries.mjs) | Bounded SDK retries, request IDs, rate limits and ambiguous failures |
| [tools-and-json.mjs](tools-and-json.mjs) | Tool-call parameters and JSON output for capable models |
| [messages.mjs](messages.mjs) | QCloud's supported Anthropic-style Messages subset |
| [node-server.mjs](node-server.mjs) | A plain Node.js HTTP server, without a framework dependency |
| [Next.js route](nextjs/app/api/chat/route.ts) | Server-side route handler to copy into a Next.js application |
| [worker.mjs](worker.mjs) | Background processing with explicit request outcomes |
| [queue-draft.ts](queue-draft.ts) | Queue planning records, without starting a worker |
| [upload-file.mjs](upload-file.mjs) / [download-file.mjs](download-file.mjs) | Explicitly enabled generation file APIs |

Run a standalone `.mjs` example with `node examples/<name>.mjs`. Framework and
TypeScript files are integration templates; follow their comments for inputs and
additional dependencies. Generation and queue runtime availability is separate
from installing the SDK. Check capability flags and model schemas before using
those resources.

## Handling failures

The SDK retries read-only requests and eligible pre-dispatch rejections/failures.
It does not replay an inference POST after an ambiguous timeout, connection reset
or server error, and it never resumes an interrupted stream. Set `maxRetries: 0`
for a single attempt. `Retry-After` and request IDs are available on typed API
errors; see the [reliability guide](../README.md#reliability) for the full policy.

Breaking stream iteration or calling `await stream.abort()` releases its HTTP
body. An `AbortSignal` preserves your cancellation reason. Cancellation does not
prove a provider stopped computing or that no usage was charged. Save partial
output only if your application can distinguish it from a complete response.

## Offline checks

`npm run check` uses local mock transports and includes cancellation, fragmented
streaming and retry regressions. `npm run check:package` installs the built archive
and its pinned runtime dependency in a clean, offline consumer and verifies both
ESM and CommonJS. Neither command needs a QCloud key or submits model requests.
