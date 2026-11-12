# Changelog

## 0.4.0 — source candidate, not published

- Cancellation and deadlines now stop buffered SSE events between consumer yields, including explicit `stream.abort()`.
- Clean consumer package checks run on Windows through Node's npm entry point without shell invocation.
- Runnable streaming/cancellation and error/retry examples, with a cross-platform examples guide and corrected Messages documentation.
- `APIError` now carries the request ID (`X-Request-ID`, or `request-id` from Messages), response headers, parsed `Retry-After`, reported admission rate limits and the server error code, and keeps the server's error type.
- New `BadRequestError` (400), `ConflictError` (409) and `UnprocessableEntityError` (422), all subclasses of `APIError`.
- POST requests are retried after connection failures that occurred before the request was sent. Ambiguous failures after sending are still never replayed.
- `client.messages` for the supported subset of QCloud's Anthropic Messages bridge, with named-event streaming that ends at `message_stop`.
- Contract tests with the official OpenAI and Anthropic clients; release workflow with build-once artifacts, checksums, provenance attestations and Trusted Publishing.
- Examples for web frameworks and background workers.

## 0.3.0 — source candidate, not published to npm

- Queue planning and inactive runtime resources, including endpoint/job quotes bound to one request UUID and exact decimal estimates.
- Strict resource identity, public response projection and recovery IDs; quote, launch and submission never retry automatically.
- Native WebSocket messages with pinned `ws`, bounded I/O and explicit session/billing cleanup; no automatic reconnection or media peer support.
- Package archive installation checks exercise both ESM and CommonJS without source-tree dependencies.
- Correct source installation, runtime dependency and OpenAI/Anthropic compatibility guidance.

- Stream local files, bytes, and async byte sources into private generation input references with size/hash validation, cancellation and no retries.

- Authenticated generated-file downloads with bounded binary streaming, byte ranges, timeout/abort cleanup and no automatic retries or file writes.

- OpenAPI/AsyncAPI reference metadata and per-model documentation preserving native message contracts and explicit documentation gaps.
- Discriminated WebRTC-over-WebSocket capabilities with native protocol validation.
- Explicit stream-body cancellation preserves deadlines and caller aborts under Node.js garbage collection.
- Generation session controls, single-use connection capabilities, and WebRTC signaling streams with explicit cleanup.
- Transport-aware catalog types and references that preserve native OpenAPI dialects and incomplete-schema notices.
- Universal generation catalog/schema discovery and durable job submit/status/result/cancel helpers.
- Deadline/abort-aware polling, explicit metered consent, and stable submission recovery IDs.
- Arbitrary JSON inputs and outputs; no automatic generation POST retries.
- Per-model documentation renderer preserving schema references and license notices.
- Local HTTP generation tests and cross-language backend contract coverage.

## 0.2.0 — earlier source baseline

- Backend HTTP contract tests for Python, TypeScript, streaming, cancellation and organization isolation.
- Explicit organization selection and typed published-model catalog metadata.
- Do not replay potentially billed POST requests after ambiguous failures.
- Reject truncated streams and preserve request IDs on streamed API errors.
- QCloud organization branding and package metadata.
- Functional bounded retries and Retry-After handling.
- HTTP error checks before streaming and typed malformed-response errors.
- SSE framing, Unicode, completion-marker, and cleanup fixes.
- Injectable HTTP transport for local testing.
- Updated usage examples, compatibility boundaries, and CI checks.
