import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import test from "node:test";
import { QCloud, GenerationJobError, GenerationTimeoutError, GenerationPendingResult, APIError, APIResponseValidationError, renderGenerationModelReference } from "../src/index.js";
import type { GenerationJob, GenerationModel } from "../src/index.js";

const modelId="qcloud/test/nested";
const model:GenerationModel={id:modelId,object:"generation.model",display_name:"Nested model",category:"image-to-video",description:"Fixture",status:"active",available:true,transport:"queue",queued_available:true,schema_available:true,license:{name:"Model license",notice:"Preserve this notice"},updated_at:new Date().toISOString(),schema_url:"/generation/models/qcloud%2Ftest%2Fnested/schema",pricing:{unit:"output",variable:true}};
const schema={openapi:"3.1.0",info:{title:"QCloud Generation",version:"1"},"x-qcloud-model":model,components:{schemas:{NestedInput:{type:"object",properties:{data:{$ref:"#/components/schemas/Arbitrary"}}},Arbitrary:{oneOf:[{type:"null"},{type:"array"}]}}}};
const billing={mode:"metered" as const,status:"settled" as const,currency:"USD" as const,markup_multiplier:2,cost_usd:0.012};
function job(id:string,status:GenerationJob["status"]="queued"):GenerationJob{return {object:"generation.job",id,model:modelId,status,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),completed_at:status==="succeeded"?new Date().toISOString():null,deadline_at:new Date(Date.now()+3600000).toISOString(),cancel_requested:false,error:status==="failed"?{code:"generation_failed",message:"Model execution failed"}:null,billing,result_url:status==="succeeded"?`/generation/jobs/${id}/result`:null};}
test("model references preserve admission limits and withhold unavailable execution examples", () => {
  const admission_policy = {id:"fixture-fixed-image",fields:{image_size:{width:512,height:512},num_images:1},
    all_fields_required:true,additional_fields:false,reservation_notice:"Reservations are review thresholds, not spending caps."};
  const allowed:GenerationModel={...model,admission_policy,availability_reason:null};
  const reference=renderGenerationModelReference(allowed,{...schema,"x-qcloud-model":allowed});
  assert.ok(reference.includes(JSON.stringify(admission_policy,null,2)));
  assert.match(reference,/complete schema may describe settings that QCloud does not currently accept/);
  assert.ok(reference.includes('client.generation.jobs.subscribe'));
  for(const row of [{...allowed,available:false},{...allowed,queued_available:false},
    {...model,available:false,queued_available:false,admission_policy:null,availability_reason:"generation_budget_model_unsupported"}]) {
    const blocked=renderGenerationModelReference(row,schema);
    assert.ok(!blocked.includes('client.generation.jobs.subscribe'));
    assert.ok(blocked.includes(JSON.stringify(schema,null,2)));
  }
  assert.ok(!renderGenerationModelReference(allowed,{...schema,"x-qcloud-model":{...allowed,available:false}}).includes('client.generation.jobs.subscribe'));
});

async function fixture(){
  const id=randomUUID();const state={posts:0,cancels:0,reads:0,resultReads:0,bodies:[] as unknown[],urls:[] as string[],failure:0,terminal:"succeeded" as GenerationJob["status"],stall:false,mismatch:false};
  const server=createServer(async(req,res)=>{state.urls.push(req.url!);res.setHeader("content-type","application/json");res.setHeader("x-request-id","generation-http-fixture");const send=(body:unknown,status=200)=>{res.statusCode=status;res.end(JSON.stringify(body));};
    if(req.url!.startsWith("/v1/generation/models")){if(req.url!.endsWith("/schema"))return send(schema);if(req.url!.includes("qcloud%2Ftest%2Fnested"))return send(model);return send({object:"list",data:[model],has_more:false,next_cursor:null,catalog:{last_updated_at:model.updated_at,stale:false,total:1}});}
    if(req.url==="/v1/generation/jobs"&&req.method==="POST"){state.posts++;let raw="";for await(const part of req)raw+=part;state.bodies.push(JSON.parse(raw));if(state.failure)return send({error:{type:"test_failure",message:"fixture unavailable"}},state.failure);return send({data:job(id)},202);}
    if(req.url!.endsWith("/cancel")){state.cancels++;return send({data:{...job(id,"cancelled"),cancel_requested:true}},202);}
    if(state.stall)return;
    if(req.url!.endsWith("/result")){state.resultReads++;if(state.resultReads===1)return send({data:job(id,"running")},202);return send({job_id:state.mismatch?randomUUID():id,data:[{nested:{ok:true}},null,42,"🌍"],billing});}
    state.reads++;return send({data:job(state.mismatch?randomUUID():id,state.reads<2?"running":state.terminal)});
  });await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=(server.address() as {port:number}).port;
  const client=new QCloud({apiKey:"qc-fixture",baseURL:`http://127.0.0.1:${port}/v1`,maxRetries:3,timeout:5000});
  return {id,state,client,close:()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());})};
}
test("generation discovery encodes IDs once and preserves full schemas/notices",async()=>{const f=await fixture();try{assert.equal((await f.client.generation.models.list({q:"a b",category:"image-to-video",limit:3})).data[0].id,modelId);assert.match(f.state.urls[0],/q=a\+b/);assert.equal((await f.client.generation.models.retrieve(modelId)).id,modelId);assert.deepEqual(await f.client.generation.models.schema(modelId),schema);assert.ok(f.state.urls.some(u=>u.includes("qcloud%2Ftest%2Fnested/schema")));const reference=renderGenerationModelReference(model,schema);assert.ok(reference.includes("#/components/schemas/Arbitrary"));assert.ok(reference.includes("Preserve this notice"));assert.ok(reference.includes('billing_mode: "metered"'));}finally{await f.close();}});

test("model references preserve historical provenance and creator notices without runnable examples", () => {
  const captured = "2026-11-01T10:00:00Z", checked = "2026-11-08T10:00:00Z";
  const retained: GenerationModel = { ...model, description: "Developed by fal.ai and Example Studio.", reference_status: "retained", reference_stale: true,
    reference_updated_at: captured, reference_checked_at: checked, reference_issue: "upstream_reference_unavailable", available: false, queued_available: false };
  const document = { ...schema, "x-qcloud-model": retained, info: { ...schema.info, license: { name: "Original terms", url: "https://creator.example/license" } } };
  const text = renderGenerationModelReference(retained, document);
  assert.match(text, /Historical reference retained/); assert.match(text, /does not establish that the model was retired/);
  assert.ok(text.includes(captured) && text.includes(checked)); assert.ok(text.includes(retained.description));
  assert.ok(text.includes("Preserve this notice") && text.includes("https://creator.example/license"));
  assert.ok(!text.includes("client.generation.jobs.subscribe")); assert.ok(text.includes(JSON.stringify(document, null, 2)));
  // A newer schema can reveal quarantine after a list response was captured.
  assert.ok(!renderGenerationModelReference(model, document).includes("client.generation.jobs.subscribe"));
  for (const candidate of [{ ...model, reference_status: "unavailable" as const }, { ...model, reference_stale: true }]) {
    assert.ok(!renderGenerationModelReference(candidate, schema).includes("client.generation.jobs.subscribe"));
  }
  assert.ok(!renderGenerationModelReference(model, null).includes("client.generation.jobs.subscribe"));
  const restored: GenerationModel = { ...model, reference_status: "current", reference_stale: false };
  assert.ok(renderGenerationModelReference(restored, { ...schema, "x-qcloud-model": restored }).includes("client.generation.jobs.subscribe"));
});
test("generic submit, pending results, subscribe and explicit cancellation preserve JSON",async()=>{const f=await fixture();try{const requestId=randomUUID(),input={arbitrary:[true,null,123,{text:"こんにちは"}]};const submitted=await f.client.generation.jobs.submit({model:modelId,input,billing_mode:"metered",client_request_id:requestId});assert.equal(submitted.id,f.id);assert.deepEqual(f.state.bodies[0],{model:modelId,input,billing_mode:"metered",client_request_id:requestId});const pending=await f.client.generation.jobs.result(f.id);assert.ok(!("job_id"in pending));assert.equal((pending as GenerationPendingResult).data.status,"running");const result=await f.client.generation.jobs.subscribe({model:modelId,input:null,billing_mode:"metered"},{pollIntervalMs:5,timeoutMs:1000});assert.deepEqual(result.result.data,[{nested:{ok:true}},null,42,"🌍"]);assert.equal(result.job.id,f.id);assert.equal((await f.client.generation.jobs.cancel(f.id)).status,"cancelled");assert.equal(f.state.cancels,1);}finally{await f.close();}});
test("terminal failures retain the job and do not request cancellation",async()=>{for(const status of ["failed","cancelled","review"] as const){const f=await fixture();try{f.state.terminal=status;await assert.rejects(f.client.generation.jobs.wait(f.id,{pollIntervalMs:1,timeoutMs:1000}),e=>e instanceof GenerationJobError&&e.job.status===status&&e.job.id===f.id);assert.equal(f.state.cancels,0);}finally{await f.close();}}});
test("poll deadline and abort stop in-flight HTTP without cancelling the job",async()=>{const f=await fixture();try{f.state.stall=true;const started=Date.now();await assert.rejects(f.client.generation.jobs.wait(f.id,{timeoutMs:40}),e=>e instanceof GenerationTimeoutError&&e.jobId===f.id);assert.ok(Date.now()-started<500);const controller=new AbortController();const pending=f.client.generation.jobs.wait(f.id,{signal:controller.signal,timeoutMs:1000});setTimeout(()=>controller.abort(new Error("caller stopped")),20);await assert.rejects(pending,/caller stopped/);assert.equal(f.state.cancels,0);}finally{await f.close();}});

async function withoutAbortSignalAny(run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
  try { await run(); } finally {
    if (original) Object.defineProperty(AbortSignal, "any", original);
    else Reflect.deleteProperty(AbortSignal, "any");
  }
}
test("Node 20 polling without AbortSignal.any completes and releases caller listeners", async () => {
  await withoutAbortSignalAny(async () => {
    const f = await fixture(), controller = new AbortController();
    try {
      const options = { signal: controller.signal, pollIntervalMs: 1, timeoutMs: 1000 };
      assert.equal((await f.client.generation.jobs.wait(f.id, options)).id, f.id);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      const result = await f.client.generation.jobs.subscribe({ model: modelId, input: null, billing_mode: "metered" }, options);
      assert.equal(result.job.id, f.id); assert.equal(f.state.posts, 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      f.state.terminal = "failed";
      await assert.rejects(f.client.generation.jobs.wait(f.id, options), GenerationJobError);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { await f.close(); }
  });
});
test("Node 20 caller cancellation without AbortSignal.any preserves reason and never cancels the remote job", async () => {
  await withoutAbortSignalAny(async () => {
    for (const subscribe of [false, true]) {
      const f = await fixture();
      const invoke = (signal: AbortSignal) => subscribe
        ? f.client.generation.jobs.subscribe({ model: modelId, input: null, billing_mode: "metered" }, { signal, timeoutMs: 1000 })
        : f.client.generation.jobs.wait(f.id, { signal, timeoutMs: 1000 });
      try {
        const reason = new Error("caller cancellation fixture"), early = new AbortController(); early.abort(reason);
        await assert.rejects(invoke(early.signal), error => error === reason);
        assert.deepEqual(f.state.urls, []); assert.equal(getEventListeners(early.signal, "abort").length, 0);
        f.state.stall = true;
        const controller = new AbortController(), pending = invoke(controller.signal);
        const deadline = Date.now() + 1000;
        while (!f.state.urls.some(url => url === `/v1/generation/jobs/${f.id}`) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
        assert.ok(f.state.urls.some(url => url === `/v1/generation/jobs/${f.id}`));
        assert.equal(getEventListeners(controller.signal, "abort").length, 1);
        controller.abort(reason); await assert.rejects(pending, error => error === reason);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0); assert.equal(f.state.cancels, 0);
        assert.equal(f.state.posts, subscribe ? 1 : 0);
      } finally { await f.close(); }
    }
  });
});
test("Node 20 deadline without AbortSignal.any releases listeners and keeps submission identity", async () => {
  await withoutAbortSignalAny(async () => {
    for (const subscribe of [false, true]) {
      const f = await fixture(), controller = new AbortController(), requestId = randomUUID();
      try {
        f.state.stall = true;
        const options = { signal: controller.signal, timeoutMs: 60 }, start = Date.now();
        const pending = subscribe
          ? f.client.generation.jobs.subscribe({ model: modelId, input: null, billing_mode: "metered", client_request_id: requestId }, options)
          : f.client.generation.jobs.wait(f.id, options);
        await assert.rejects(pending, error => error instanceof GenerationTimeoutError && error.jobId === f.id && (!subscribe || error.clientRequestId === requestId));
        assert.ok(Date.now() - start < 1000); assert.equal(controller.signal.aborted, false);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0); assert.equal(f.state.cancels, 0);
      } finally { await f.close(); }
    }
  });
});
test("submission failures retain retry identity and never auto-replay billed POST",async()=>{for(const status of [429,503]){const f=await fixture();try{f.state.failure=status;const id=randomUUID();await assert.rejects(f.client.generation.jobs.submit({model:modelId,input:[],billing_mode:"metered",client_request_id:id}),e=>e instanceof APIError&&e.status===status&&e.clientRequestId===id);assert.equal(f.state.posts,1);}finally{await f.close();}}});
test("invalid consent/JSON fails locally; response identity mismatches fail closed",async()=>{const f=await fixture();try{await assert.rejects(f.client.generation.jobs.submit({model:modelId,input:NaN,billing_mode:"metered"}),/JSON/);await assert.rejects(f.client.generation.jobs.submit({model:modelId,input:null,billing_mode:"free" as "metered"}),/metered/);assert.equal(f.state.posts,0);f.state.mismatch=true;await assert.rejects(f.client.generation.jobs.retrieve(f.id),APIResponseValidationError);await assert.rejects(f.client.generation.jobs.wait(f.id,{timeoutMs:1000}),APIResponseValidationError);f.state.resultReads=1;await assert.rejects(f.client.generation.jobs.result(f.id),APIResponseValidationError);}finally{await f.close();}});

test("uppercase job and request UUIDs use canonical paths and retain strict response identity", async () => {
  const f = await fixture(), upper = f.id.toUpperCase();
  const requestId = "ABCDEF12-3456-4789-ABCD-EF1234567890";
  const params = { model: modelId, input: null, billing_mode: "metered" as const, client_request_id: requestId };
  try {
    await f.client.generation.jobs.submit(params);
    assert.equal((f.state.bodies[0] as { client_request_id: string }).client_request_id, requestId.toLowerCase());
    assert.equal((await f.client.generation.jobs.retrieve(upper)).id, f.id);
    const pending = await f.client.generation.jobs.result(upper);
    assert.ok(!("job_id" in pending)); assert.equal(pending.data.id, f.id);
    const complete = await f.client.generation.jobs.result(upper);
    assert.ok("job_id" in complete); assert.equal(complete.job_id, f.id);
    assert.equal((await f.client.generation.jobs.wait(upper, { pollIntervalMs: 1, timeoutMs: 1000 })).id, f.id);
    assert.equal((await f.client.generation.jobs.cancel(upper)).id, f.id);
    assert.equal((await f.client.generation.jobs.subscribe(params, { pollIntervalMs: 1, timeoutMs: 1000 })).job.id, f.id);
    assert.ok(f.state.urls.filter(url => url !== "/v1/generation/jobs").every(url => url.startsWith(`/v1/generation/jobs/${f.id}`)));
    assert.ok(f.state.bodies.every(body => (body as { client_request_id: string }).client_request_id === requestId.toLowerCase()));
    f.state.failure = 503;
    await assert.rejects(f.client.generation.jobs.submit(params), error => error instanceof APIError && error.clientRequestId === requestId.toLowerCase());
    f.state.mismatch = true;
    await assert.rejects(f.client.generation.jobs.retrieve(upper), APIResponseValidationError);
    await assert.rejects(f.client.generation.jobs.result(upper), APIResponseValidationError);
  } finally { await f.close(); }
});

test("malformed job UUIDs and alternate UUID forms fail before HTTP", async () => {
  const f = await fixture();
  try {
    for (const id of [`{${f.id}}`, f.id.replaceAll("-", ""), ` ${f.id}`, `${f.id}\n`, `g${f.id.slice(1)}`, f.id.slice(1)]) {
      await assert.rejects(f.client.generation.jobs.retrieve(id), /UUID/);
      await assert.rejects(f.client.generation.jobs.cancel(id), /UUID/);
      await assert.rejects(f.client.generation.jobs.result(id), /UUID/);
      await assert.rejects(f.client.generation.jobs.wait(id), /UUID/);
      const params = { model: modelId, input: null, billing_mode: "metered" as const, client_request_id: id };
      await assert.rejects(f.client.generation.jobs.submit(params), /UUID/);
      await assert.rejects(f.client.generation.jobs.subscribe(params), /UUID/);
    }
    assert.deepEqual(f.state.urls, []);
  } finally { await f.close(); }
});
