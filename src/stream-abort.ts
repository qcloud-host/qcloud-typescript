/** Cancel the owned body directly: fetch's abort linkage may be collected after
 * response headers when only a reader remains reachable. */
export function bindStreamAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}
