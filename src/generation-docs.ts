import type { GenerationModel, GenerationSchema } from "./types/generation.js";

function block(value: string, language: string): string {
  const longest = Math.max(2, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}
function heading(value: string): string { return value.replace(/[\r\n]/g, " ").replace(/[<>#*_[\]`]/g, ""); }

/** Render any discovered model without guessing inputs or flattening schema references. */
export function renderGenerationModelReference(model: GenerationModel, schema: GenerationSchema | null): string {
  const id = JSON.stringify(model.id);
  const queued = model.transport === "queue";
  const python = [
    "import json", "from uuid import uuid4", "from qcloud_ai import QCloud", "",
    "client = QCloud()", "with open(\"input.json\", encoding=\"utf-8\") as file:", "    model_input = json.load(file)",
    "result = client.generation.jobs.subscribe(", `    model=${id},`, "    input=model_input,", "    billing_mode=\"metered\",", "    client_request_id=str(uuid4()),", "    timeout=600,", ")", "print(result.result.data)",
  ].join("\n");
  const typescript = [
    'import { readFile } from "node:fs/promises";', 'import { randomUUID } from "node:crypto";', 'import { QCloud } from "qcloud-ai";', "",
    'const input = JSON.parse(await readFile("input.json", "utf8"));', "const client = new QCloud();", "const result = await client.generation.jobs.subscribe({", `  model: ${id},`, '  input, billing_mode: "metered", client_request_id: randomUUID(),', "}, { timeoutMs: 600_000 });", "console.log(result.result.data);",
  ].join("\n");
  return [
    `# ${heading(model.display_name || model.id)}`, "", block(model.id, "text"), "",
    `Category: ${heading(model.category)}. Status: ${heading(model.status)}. Transport: ${heading(model.transport)}. Available: ${model.available ? "yes" : "no"}.`, "",
    ...(model.schema_issues?.length ? ["The supplied model schema is incomplete. These unresolved references are preserved as evidence; no missing input definition is invented:", "", block(JSON.stringify(model.schema_issues, null, 2), "json"), ""] : []),
    schema === null
      ? "A detailed input/output schema is currently unavailable. Retrieve it before submitting a job. This reference preserves catalog metadata and license notices without inventing input fields."
      : queued ? "Use the exact input schema below to create `input.json`. Inputs and outputs vary by model; these examples do not invent required field values."
      : "The native schema components below describe this model's transport. No queued job operation or required input is invented for this reference.", "",
    ...(queued ? [
      "Submission explicitly accepts variable metered charges. Polling timeout or client cancellation does not cancel the job. Retain the UUID and original body for recovery after an ambiguous submission.", "",
      "## Python", "", block(python, "python"), "", "## TypeScript", "", block(typescript, "typescript"), "",
    ] : ["This model does not support the QCloud queued-job API. Its transport requires a separate supported session API; the catalog reference and native schema do not imply execution availability.", ""]),
    "## License and notices", "", block(JSON.stringify(model.license, null, 2), "json"), "",
    "## Pricing metadata", "", block(JSON.stringify(model.pricing ?? null, null, 2), "json"), "",
    "## Complete model schema", "", schema === null ? "Schema unavailable in this catalog snapshot." : "The complete OpenAPI document preserves component names, references, constraints, and model notices.", "", block(JSON.stringify(schema, null, 2), "json"), "",
  ].join("\n");
}
