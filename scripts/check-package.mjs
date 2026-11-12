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
// npm.cmd cannot be executed directly by execFile on Windows. npm exposes its
// JavaScript entry point to lifecycle scripts, so invoke it with Node without a
// shell (also preserving spaces and metacharacters in archive paths).
const npmCLI = process.env.npm_execpath;
assert.ok(npmCLI && existsSync(npmCLI), "Run this check with npm run check:package");
const env = { ...process.env, NODE_PATH: "" };
for (const key of ["QCLOUD_API_KEY", "QCLOUD_BASE_URL", "QCLOUD_ORGANIZATION_ID"]) delete env[key];
const run = (command, args, cwd = temp) => execFileSync(command, args, {
  cwd, encoding: "utf8", timeout: 120_000, env,
});
const runNpm = (args, cwd = temp) => run(process.execPath, [npmCLI, ...args], cwd);
try {
  const [archive] = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", temp], root));
  assert.equal(archive.name, metadata.name);
  assert.equal(archive.version, metadata.version);
  const files = archive.files.map(file => file.path);
  for (const path of ["dist/index.js", "dist/index.cjs", "dist/index.d.ts", "dist/index.d.cts", "README.md", "LICENSE", "package.json"])
    assert.ok(files.includes(path), `Missing archive file: ${path}`);
  assert.ok(files.every(path => path.startsWith("dist/") || ["README.md", "LICENSE", "package.json"].includes(path)), "Unexpected archive contents");
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // npm ci need not cache registry metadata. Pack the installed exact runtime
  // dependency so the clean consumer can resolve it without any registry cache.
  const dependencies = process.env.QCLOUD_NPM_DEPENDENCY_ARCHIVES
    ? JSON.parse(process.env.QCLOUD_NPM_DEPENDENCY_ARCHIVES)
    : Object.entries(metadata.dependencies).map(([name, version]) => {
      const directory = join(root, "node_modules", name);
      const installed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      assert.equal(installed.name, name);
      assert.equal(installed.version, version, "Runtime dependency must match the exact package pin");
      const [dependency] = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", temp, directory], root));
      assert.equal(dependency.name, name); assert.equal(dependency.version, version);
      return join(temp, dependency.filename);
    });
  assert.ok(Array.isArray(dependencies) && dependencies.every(path => typeof path === "string" && existsSync(path)));
  runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev",
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
