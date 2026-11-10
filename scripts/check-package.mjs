import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run after build. The consumer has no access to the source tree or dev dependencies.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "qcloud-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, NODE_PATH: "" };
for (const key of ["QCLOUD_API_KEY", "QCLOUD_BASE_URL", "QCLOUD_ORGANIZATION_ID"]) delete env[key];
const run = (command, args, cwd = temp) => execFileSync(command, args, {
  cwd, encoding: "utf8", timeout: 120_000, env,
});
try {
  const [archive] = JSON.parse(run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], root));
  assert.equal(archive.name, metadata.name);
  assert.equal(archive.version, metadata.version);
  const files = archive.files.map(file => file.path);
  for (const path of ["dist/index.js", "dist/index.cjs", "dist/index.d.ts", "dist/index.d.cts", "README.md", "LICENSE", "package.json"])
    assert.ok(files.includes(path), `Missing archive file: ${path}`);
  assert.ok(files.every(path => path.startsWith("dist/") || ["README.md", "LICENSE", "package.json"].includes(path)), "Unexpected archive contents");
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // Optional exact runtime tarballs let an offline release host reuse reviewed caches.
  const dependencies = JSON.parse(process.env.QCLOUD_NPM_DEPENDENCY_ARCHIVES || "[]");
  assert.ok(Array.isArray(dependencies) && dependencies.every(path => typeof path === "string" && existsSync(path)));
  run(npm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev",
    join(temp, archive.filename), ...dependencies]);
  const smoke = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import QCloud, * as esm from "qcloud-ai";
const require = createRequire(import.meta.url);
const cjs = require("qcloud-ai");
const installed = JSON.parse(readFileSync("node_modules/qcloud-ai/package.json", "utf8"));
assert.equal(installed.version, ${JSON.stringify(metadata.version)});
assert.deepEqual(installed.dependencies, ${JSON.stringify(metadata.dependencies)});
for (const sdk of [esm, cjs]) {
  assert.equal(sdk.SDK_VERSION, installed.version);
  assert.equal(typeof sdk.GenerationSocket, "function");
  let calls = 0;
  const client = new sdk.QCloud({ apiKey: "qc-package-fixture", fetch: async (url, options) => {
    calls++;
    assert.equal(String(url), "https://platform.qcloud.host/api/v1/models");
    assert.equal(new Headers(options.headers).get("user-agent"), "qcloud-ai-node/" + installed.version);
    return Response.json({ object: "list", data: [] });
  } });
  assert.equal(typeof client.serverless.queue.runtime.endpoints.quote, "function");
  assert.equal(typeof client.serverless.queue.runtime.jobs.quote, "function");
  assert.equal(typeof client.generation.sessions.openSocket, "function");
  assert.deepEqual(await client.models.list(), { object: "list", data: [] });
  assert.equal(calls, 1);
}
assert.equal(QCloud, esm.QCloud);
console.log("Installed package: ESM, CommonJS, runtime dependencies, default API origin and mocked GET passed");
`;
  writeFileSync(join(temp, "smoke.mjs"), smoke);
  process.stdout.write(run(process.execPath, ["smoke.mjs"]));
  console.log(JSON.stringify({ package: archive.name, version: archive.version, shasum: archive.shasum, integrity: archive.integrity }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
