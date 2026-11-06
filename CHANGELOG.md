# Changelog

## Unreleased

- Explicit stream-body cancellation preserves deadlines and caller aborts under Node.js garbage collection.
- Generation session controls, single-use connection capabilities, and WebRTC signaling streams with explicit cleanup.
- Transport-aware catalog types and references that preserve native OpenAPI dialects and incomplete-schema notices.
- Universal generation catalog/schema discovery and durable job submit/status/result/cancel helpers.
- Deadline/abort-aware polling, explicit metered consent, and stable submission recovery IDs.
- Arbitrary JSON inputs and outputs; no automatic generation POST retries.
- Per-model documentation renderer preserving schema references and license notices.
- Local HTTP generation tests and cross-language backend contract coverage.

## 0.2.0

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
