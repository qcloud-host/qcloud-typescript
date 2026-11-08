import { randomUUID } from "node:crypto";
import QCloud from "qcloud-ai";

const client = new QCloud(); // QCLOUD_API_KEY; optional QCLOUD_ORGANIZATION_ID
const catalog = await client.serverless.queue.catalog();
if (!catalog.creation_available) throw new Error("No queue draft profiles are available");
// Persist this UUID with your intent before sending. Reuse it only with the same
// name, profile and organization to recover a lost acknowledgement explicitly.
const client_request_id = randomUUID();
const draft = await client.serverless.queue.deployments.create({
  name: "My model draft", profile_id: catalog.profiles[0].id, client_request_id,
});
console.log(await client.serverless.queue.deployments.retrieve(draft.id));
console.log((await client.serverless.queue.deployments.list()).data);
// status is "draft": no endpoint, worker, inference request or charge exists.
