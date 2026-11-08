import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { QCloud, GenerationJobError, GenerationTimeoutError, GenerationPendingResult, APIError, APIResponseValidationError, renderGenerationModelReference } from "../src/index.js";
import type { GenerationJob, GenerationModel } from "../src/index.js";

const modelId="qcloud/test/nested";
const model:GenerationModel={id:modelId,object:"generation.model",display_name:"Nested model",category:"image-to-video",description:"Fixture",status:"active",available:true,transport:"queue",queued_available:true,schema_available:true,license:{name:"Model license",notice:"Preserve this notice"},updated_at:new Date().toISOString(),schema_url:"/generation/models/qcloud%2Ftest%2Fnested/schema",pricing:{unit:"output",variable:true}};
const schema={openapi:"3.1.0",info:{title:"QCloud Generation",version:"1"},"x-qcloud-model":model,components:{schemas:{NestedInput:{type:"object",properties:{data:{$ref:"#/components/schemas/Arbitrary"}}},Arbitrary:{oneOf:[{type:"null"},{type:"array"}]}}}};
const billing={mode:"metered" as const,status:"settled" as const,currency:"USD" as const,markup_multiplier:2,cost_usd:0.012};
function job(id:string,status:GenerationJob["status"]="queued"):GenerationJob{return {object:"generation.job",id,model:modelId,status,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),completed_at:status==="succeeded"?new Date().toISOString():null,deadline_at:new Date(Date.now()+3600000).toISOString(),cancel_requested:false,error:status==="failed"?{code:"generation_failed",message:"Model execution failed"}:null,billing,result_url:status==="succeeded"?`/generation/jobs/${id}/result`:null};}
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
test("generic submit, pending results, subscribe and explicit cancellation preserve JSON",async()=>{const f=await fixture();try{const requestId=randomUUID(),input={arbitrary:[true,null,123,{text:"こんにちは"}]};const submitted=await f.client.generation.jobs.submit({model:modelId,input,billing_mode:"metered",client_request_id:requestId});assert.equal(submitted.id,f.id);assert.deepEqual(f.state.bodies[0],{model:modelId,input,billing_mode:"metered",client_request_id:requestId});const pending=await f.client.generation.jobs.result(f.id);assert.ok(!("job_id"in pending));assert.equal((pending as GenerationPendingResult).data.status,"running");const result=await f.client.generation.jobs.subscribe({model:modelId,input:null,billing_mode:"metered"},{pollIntervalMs:5,timeoutMs:1000});assert.deepEqual(result.result.data,[{nested:{ok:true}},null,42,"🌍"]);assert.equal(result.job.id,f.id);assert.equal((await f.client.generation.jobs.cancel(f.id)).status,"cancelled");assert.equal(f.state.cancels,1);}finally{await f.close();}});
test("terminal failures retain the job and do not request cancellation",async()=>{for(const status of ["failed","cancelled","review"] as const){const f=await fixture();try{f.state.terminal=status;await assert.rejects(f.client.generation.jobs.wait(f.id,{pollIntervalMs:1,timeoutMs:1000}),e=>e instanceof GenerationJobError&&e.job.status===status&&e.job.id===f.id);assert.equal(f.state.cancels,0);}finally{await f.close();}}});
test("poll deadline and abort stop in-flight HTTP without cancelling the job",async()=>{const f=await fixture();try{f.state.stall=true;const started=Date.now();await assert.rejects(f.client.generation.jobs.wait(f.id,{timeoutMs:40}),e=>e instanceof GenerationTimeoutError&&e.jobId===f.id);assert.ok(Date.now()-started<500);const controller=new AbortController();const pending=f.client.generation.jobs.wait(f.id,{signal:controller.signal,timeoutMs:1000});setTimeout(()=>controller.abort(new Error("caller stopped")),20);await assert.rejects(pending,/caller stopped/);assert.equal(f.state.cancels,0);}finally{await f.close();}});
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
