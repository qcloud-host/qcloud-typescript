import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real HTTP inference and session streams retain deadlines and cancellation under garbage collection", { timeout: 20_000 }, async () => {
  await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(new URL("./fixtures/stream-gc.mjs", import.meta.url))], { timeout: 15_000 });
});
