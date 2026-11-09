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
  const schemaModel = schema?.["x-qcloud-model"] as Partial<GenerationModel> | undefined;
  const references = [model, schemaModel].filter((value): value is GenerationModel => Boolean(value));
  const retained = references.some(value => value.reference_status === "retained");
  const unavailable = references.some(value => value.reference_status === "unavailable") || schema === null;
  const stale = references.some(value => value.reference_stale === true);
  const executionUnavailable = references.some(value => value.available === false || value.queued_available === false);
  const blocked = retained || unavailable || stale || executionUnavailable;
  const admissionPolicy = model.admission_policy ?? schemaModel?.admission_policy;
  const captured = schemaModel?.reference_updated_at ?? model.reference_updated_at;
  const asynchronous = typeof schema?.asyncapi === "string";
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
    `Category: ${heading(model.category)}. Status: ${heading(model.status)}. Transport: ${heading(model.transport)}. Available: ${model.available && !blocked ? "yes" : "no"}.`, "",
    ...(model.description ? [block(model.description, "text"), ""] : []),
    `Reference status: ${retained ? "retained historical contract" : unavailable ? "unavailable" : stale ? "stale" : model.reference_status ?? "not provided by this snapshot"}. Captured: ${captured ? heading(captured) : "unknown"}. Checked: ${model.reference_checked_at ? heading(model.reference_checked_at) : "unknown"}.`, "",
    ...(blocked ? [retained
      ? "Historical reference retained: the latest catalog did not supply a usable contract. New jobs and sessions are blocked for this model. This does not establish that the model was retired. The captured schema and creator/license notices remain available for reference."
      : unavailable ? "No usable current reference is available. New execution is unavailable; no runnable submission examples are supplied."
      : stale ? "Reference freshness could not be verified. New execution is unavailable until the reference is refreshed; no runnable submission examples are supplied."
      : "This model is not currently available for queued execution. Its schema remains available for reference; no runnable submission examples are supplied.", ""] : []),
    ...(admissionPolicy ? ["## Request limits", "", "Follow this admission policy as well as the model schema. The complete schema may describe settings that QCloud does not currently accept. Current prices, account eligibility and spending limits are checked when submitting.", "", block(JSON.stringify(admissionPolicy, null, 2), "json"), ""] : []),
    ...(model.schema_issues?.length ? ["The supplied reference has documented gaps. Missing definitions or negotiation contracts are not invented:", "", block(JSON.stringify(model.schema_issues, null, 2), "json"), ""] : []),
    schema === null
      ? "A detailed input/output schema is currently unavailable. Retrieve it before submitting a job. This reference preserves catalog metadata and license notices without inventing input fields."
      : queued && !blocked ? "Use the input schema and any request limits above to create `input.json`. Inputs and outputs vary by model; these examples do not invent required field values."
      : queued ? "The input and output contract is preserved below for reference; it does not establish execution availability."
      : "The native schema components below describe this model's transport. No queued job operation or required input is invented for this reference.", "",
    ...(queued && !blocked ? [
      "Submission explicitly accepts variable metered charges. Polling timeout or client cancellation does not cancel the job. Retain the UUID and original body for recovery after an ambiguous submission.", "",
      "## Python", "", block(python, "python"), "", "## TypeScript", "", block(typescript, "typescript"), "",
    ] : !queued ? ["This model does not support the QCloud queued-job API. Its transport requires a separate supported session API; the catalog reference and native schema do not imply execution availability.", ""] : []),
    "## License and notices", "", block(JSON.stringify(model.license, null, 2), "json"), "",
    "## Pricing metadata", "", block(JSON.stringify(model.pricing ?? null, null, 2), "json"), "",
    "## Complete model schema", "", schema === null ? "Schema unavailable in this catalog snapshot." : asynchronous
      ? "The AsyncAPI reference preserves native message schemas, media directions, sequencing, and wire identifiers. It does not supply an unavailable HTTP negotiation contract or prove an enabled signaling route."
      : "The complete OpenAPI document preserves component names, references, constraints, and model notices.", "", block(JSON.stringify(schema, null, 2), "json"), "",
  ].join("\n");
}
