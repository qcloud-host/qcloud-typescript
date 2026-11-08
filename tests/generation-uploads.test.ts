import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { QCloud, PermissionDeniedError, RateLimitError, APIConnectionError, APITimeoutError, APIResponseValidationError } from "../src/index.js";

const id = "abcdef12-3456-4789-abcd-ef1234567890";
const bytes = Uint8Array.from({ length: 150001 }, (_, i) => i % 256);
function uploaded(size: number, filename = "upload.bin", contentType = "application/octet-stream") {
  return { data: { id, object: "generation.file", url: `qcloud://files/${id}`, filename, content_type: contentType, size_bytes: size, sha256: createHash("sha256").update(bytes).digest("hex"), created_at: "2026-11-08T00:00:00Z", expires_at: "2026-11-09T00:00:00Z" } };
}
async function fixture() {
  const state = { mode: "normal", requests: 0, outside: 0, body: Buffer.alloc(0), headers: {} as Record<string, string | string[] | undefined>, aborted: 0 };
  const outside = createServer((_req, res) => { state.outside++; res.end(); }); outside.listen(0, "127.0.0.1"); await once(outside, "listening");
  const server = createServer(async (req, res) => {
    state.requests++; state.headers = req.headers;
    req.on("error", () => {}); res.on("close", () => { if (!res.writableEnded) state.aborted++; });
    if (req.url !== "/api/v1/generation/files" || req.method !== "POST" || req.headers.authorization !== "Bearer qc-fixture") { res.writeHead(403); res.end(); return; }
    if (state.mode === "redirect") { res.writeHead(307, { location: `http://127.0.0.1:${(outside.address() as {port:number}).port}/outside` }); res.end(); return; }
    if (state.mode === "error" || state.mode === "rate") { res.writeHead(state.mode === "rate" ? 429 : 403, { "content-type": "application/json", "x-request-id": "upload-error" }); res.end(JSON.stringify({error:{message:"Upload refused"}})); return; }
    if (state.mode === "huge-error") { res.writeHead(403, {"x-request-id":"bounded-upload"}); res.end("x".repeat(200000)); return; }
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) { chunks.push(chunk); if (state.mode === "disconnect") { req.destroy(); return; } }
      state.body = Buffer.concat(chunks);
      if (state.mode === "stall") { res.writeHead(201); res.write("{"); return; }
      const result = uploaded(state.body.length, decodeURIComponent(String(req.headers["x-qcloud-filename"])), String(req.headers["x-qcloud-content-type"]));
      if (state.mode === "foreign") result.data.url = "https://outside.invalid/private";
      if (state.mode === "wrong-size") result.data.size_bytes++;
      if (state.mode === "wrong-hash") result.data.sha256="0".repeat(64);
      res.writeHead(201, {"content-type":"application/json"}); res.end(JSON.stringify(result));
    } catch { if (!res.destroyed) res.destroy(); }
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  return { state, sdk: new QCloud({apiKey:"qc-fixture",organization:id,maxRetries:5,baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1`}),
    close: async () => { server.closeAllConnections(); outside.closeAllConnections(); await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>outside.close(()=>r()))]); } };
}

test("uploads preserve bytes, filename and MIME for buffers, regular paths and chunked streams", async () => {
  const f=await fixture(), directory=await mkdtemp(join(tmpdir(),"qcloud-upload-"));
  try {
    const result=await f.sdk.generation.files.upload(bytes,{filename:"φωνή.wav",contentType:"audio/wav"});
    assert.equal(result.url,`qcloud://files/${id}`);assert.equal(result.size_bytes,bytes.length);assert.deepEqual(f.state.body,Buffer.from(bytes));
    assert.equal(f.state.headers["content-type"],"application/octet-stream");assert.equal(f.state.headers["content-length"],String(bytes.length));
    assert.equal(f.state.headers["x-qcloud-filename"],encodeURIComponent("φωνή.wav"));assert.equal(f.state.headers["x-qcloud-organization"],id);
    assert.equal((await f.sdk.generation.files.upload(bytes,{contentType:"Image/PNG"})).content_type,"image/png");
    assert.equal(f.state.headers["x-qcloud-content-type"],"image/png");
    const boundaryName="é".repeat(127)+"a", boundaryMIME="image/"+"x".repeat(121);
    assert.equal((await f.sdk.generation.files.upload(bytes,{filename:boundaryName,contentType:boundaryMIME})).content_type,boundaryMIME);
    const path=join(directory,"input.bin");await writeFile(path,bytes);
    assert.equal((await f.sdk.generation.files.upload({path})).filename,"input.bin");assert.deepEqual(f.state.body,Buffer.from(bytes));
    let finished=false;
    const stream=(async function*(){try{yield bytes.subarray(0,17);yield bytes.subarray(17);}finally{finished=true;}})();
    await f.sdk.generation.files.upload(stream);assert.ok(finished);assert.equal(f.state.headers["content-length"],undefined);assert.equal(f.state.headers["transfer-encoding"],"chunked");
    assert.deepEqual(f.state.body,Buffer.from(bytes));
  } finally { await f.close();await rm(directory,{recursive:true,force:true}); }
});

test("input validation precedes HTTP and upload-controlled headers override custom defaults",async()=>{
  let requests=0;
  const sdk=new QCloud({apiKey:"fixture",defaultHeaders:{"content-type":"application/json","Content-Length":"1","transfer-encoding":"chunked","X-QCloud-Filename":"bad"},fetch:async(_url,options)=>{
    requests++; const headers=new Headers(options?.headers);assert.equal(headers.get("content-type"),"application/octet-stream");assert.equal(headers.get("content-length"),String(bytes.length));assert.equal(headers.get("transfer-encoding"),null);
    let size=0;const reader=(options!.body as ReadableStream<Uint8Array>).getReader();try{while(true){const next=await reader.read();if(next.done)break;assert.ok(next.value.length<=65536);size+=next.value.length;}}finally{reader.releaseLock();}
    return new Response(JSON.stringify(uploaded(size)),{status:201});
  }});
  for(const source of ["https://outside.invalid/file",{path:"https://outside.invalid/file"},new Uint8Array()] as any[])await assert.rejects(sdk.generation.files.upload(source),TypeError);
  for(const filename of ["../input","a/b","a\\b",".","..","","   ","\u2003","x\n","x\u007f","x".repeat(256),"é".repeat(128),"\uD800"])await assert.rejects(sdk.generation.files.upload(bytes,{filename}),TypeError);
  for(const contentType of ["image/png\n","image/png; charset=utf8","image","!image/png","image/!png","image/"+"x".repeat(122)])await assert.rejects(sdk.generation.files.upload(bytes,{contentType}),TypeError);
  for(const maxBytes of [0,-1,Infinity,268435457])await assert.rejects(sdk.generation.files.upload(bytes,{maxBytes}),TypeError);
    for(const timeout of [0,-1,Infinity,2147483648])await assert.rejects(sdk.generation.files.upload(bytes,{timeout}),TypeError);
  await assert.rejects(sdk.generation.files.upload(bytes,{size:1}),TypeError);assert.equal(requests,0);
  await sdk.generation.files.upload(bytes);assert.equal(requests,1);
});

// Model a server that answers immediately at Content-Length, without requesting
// another source chunk. This deterministically exercises the final EOF race.
function earlyReceipt(onBytes: (body: Buffer) => void = () => {}) {
  return new QCloud({ apiKey: "fixture", fetch: async (_url, options) => {
    const headers = new Headers(options?.headers), size = Number(headers.get("content-length"));
    assert.ok(size > 0);
    const reader = (options!.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = []; let length = 0;
    try {
      while (length < size) {
        const next = await reader.read(); assert.equal(next.done, false);
        assert.ok(next.value!.length <= 65536);
        chunks.push(Buffer.from(next.value!)); length += next.value!.length;
      }
      assert.equal(length, size); onBytes(Buffer.concat(chunks));
      return new Response(JSON.stringify(uploaded(size, decodeURIComponent(headers.get("x-qcloud-filename")!), headers.get("x-qcloud-content-type")!)), { status: 201 });
    } finally { reader.releaseLock(); }
  }});
}

test("known-length uploads finalize delayed EOF before an early 201 receipt", async () => {
  let eof = false;
  const sdk = earlyReceipt(body => { assert.ok(eof); assert.deepEqual(body, Buffer.from(bytes)); });
  const source = (async function* () {
    yield bytes;
    await new Promise(resolve => setTimeout(resolve, 20));
    yield new Uint8Array(); yield new Uint8Array();
    eof = true;
  })();
  const result = await sdk.generation.files.upload(source, { size: bytes.length });
  assert.equal(result.sha256, uploaded(bytes.length).data.sha256);
  // A regular file also requires an asynchronous read after its declared bytes.
  const directory = await mkdtemp(join(tmpdir(), "qcloud-early-receipt-"));
  try {
    const path = join(directory, "input.bin"); await writeFile(path, bytes);
    assert.equal((await sdk.generation.files.upload({ path })).filename, "input.bin");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("EOF lookahead preserves a caller's reused final buffer", async () => {
  const reused = Uint8Array.from(bytes);
  const sdk = earlyReceipt(body => assert.deepEqual(body, Buffer.from(bytes)));
  await sdk.generation.files.upload((async function* () {
    yield reused;
    reused.fill(0);
    yield new Uint8Array();
  })(), { size: bytes.length });
  assert.ok(reused.every(value => value === 0));
});

test("known-length lookahead rejects extra or invalid chunks before releasing the last bytes", async () => {
  let receipts = 0;
  const sdk = earlyReceipt(() => { receipts++; });
  for (const tail of [Uint8Array.of(1), "invalid"] as any[]) {
    await assert.rejects(sdk.generation.files.upload((async function* () {
      yield bytes; yield new Uint8Array(); yield tail;
    })(), { size: bytes.length }), /declared size|Uint8Array/);
  }
  await assert.rejects(sdk.generation.files.upload((async function* () {
    yield bytes.subarray(1);
  })(), { size: bytes.length }), /declared size/);
  assert.equal(receipts, 0);
});

test("cancellation and deadline interrupt a pending final EOF without releasing its bytes", async () => {
  for (const mode of ["cancel", "timeout"]) {
    let release: (value: IteratorResult<Uint8Array>) => void = () => {}, returned = false, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const source = { [Symbol.asyncIterator]() {
      let first = true;
      return {
        next: () => first ? (first = false, Promise.resolve({ value: bytes, done: false }))
          : new Promise<IteratorResult<Uint8Array>>(resolve => { release = resolve; started(); }),
        return: async () => { returned = true; release({ value: undefined, done: true }); return { value: undefined, done: true }; },
      };
    }};
    let delivered = 0;
    const sdk = new QCloud({ apiKey: "fixture", fetch: async (_url, options) => {
      const reader = (options!.body as ReadableStream<Uint8Array>).getReader();
      try { while (true) { const next = await reader.read(); if (next.done) break; delivered += next.value.length; } }
      finally { reader.releaseLock(); }
      throw new Error("cancelled upload must not complete");
    }});
    const controller = new AbortController(), reason = new Error("stop at EOF");
    const pending = sdk.generation.files.upload(source, { size: bytes.length, signal: controller.signal, timeout: mode === "timeout" ? 40 : 1000 });
    const rejected = assert.rejects(pending, error => mode === "cancel" ? error === reason : error instanceof APITimeoutError);
    await waiting;
    if (mode === "cancel") controller.abort(reason);
    await rejected;
    assert.ok(returned); assert.equal(delivered, 2 * 65536);
  }
});

test("HTTP errors retain their type and request ID; redirects and interrupted uploads never replay",async()=>{
  const f=await fixture();
  try{
    f.state.mode="error";await assert.rejects(f.sdk.generation.files.upload(bytes),e=>e instanceof PermissionDeniedError&&e.requestID==="upload-error");
    f.state.mode="rate";await assert.rejects(f.sdk.generation.files.upload(bytes),RateLimitError);
    f.state.mode="redirect";await assert.rejects(f.sdk.generation.files.upload(bytes),APIConnectionError);assert.equal(f.state.outside,0);
    f.state.mode="disconnect";await assert.rejects(f.sdk.generation.files.upload(bytes),APIConnectionError);assert.equal(f.state.requests,4);
    f.state.mode="huge-error";await assert.rejects(f.sdk.generation.files.upload(bytes),e=>e instanceof PermissionDeniedError&&e.requestID==="bounded-upload"&&e.message.length<600);
  }finally{await f.close();}
});

test("uploads enforce declared and maximum lengths and never accept arbitrary result URLs",async()=>{
  const f=await fixture();
  try{
    for(const options of [{maxBytes:100},{size:100},{size:bytes.length+1}]){
      await assert.rejects(f.sdk.generation.files.upload((async function*(){yield bytes;})(),options),/size|maxBytes/);
    }
    await assert.rejects(f.sdk.generation.files.upload((async function*(){})()),/empty/);
    for(const mode of ["foreign","wrong-size","wrong-hash"]){f.state.mode=mode;await assert.rejects(f.sdk.generation.files.upload(bytes),APIResponseValidationError);}
  }finally{await f.close();}
});

test("response stalls time out and caller cancellation closes source iteration",async()=>{
  const f=await fixture();
  try{
    f.state.mode="stall";await assert.rejects(f.sdk.generation.files.upload(bytes,{timeout:70}),APITimeoutError);
    f.state.mode="normal";
    let returned=false, release:(value:IteratorResult<Uint8Array>)=>void=()=>{};
    const source = {
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          next: () => first ? (first = false, Promise.resolve({ value: bytes.subarray(0,100), done: false }))
            : new Promise<IteratorResult<Uint8Array>>(r => { release = r; }),
          return: async () => { returned = true; release({ value: undefined, done: true }); return { value: undefined, done: true }; },
        };
      },
    };
    const controller=new AbortController(), reason=new Error("caller stopped");
    const pending=f.sdk.generation.files.upload(source,{signal:controller.signal});setTimeout(()=>controller.abort(reason),30);
    await assert.rejects(pending,e=>e===reason);await new Promise(r=>setTimeout(r,10));assert.ok(returned);
  }finally{await f.close();}
});

test("cancelling between slices of one large input chunk stops additional bytes",async()=>{
  const controller=new AbortController();let count=0;
  const sdk=new QCloud({apiKey:"fixture",fetch:async(_url,options)=>{
    const reader=(options!.body as ReadableStream<Uint8Array>).getReader();
    const first=await reader.read();count+=first.value!.length;controller.abort(new Error("stop"));
    await assert.rejects(reader.read());throw new TypeError("request aborted");
  }});
  await assert.rejects(sdk.generation.files.upload((async function*(){yield bytes;})(),{signal:controller.signal}),/stop/);
  assert.equal(count,65536);
});

test("upload deadlines reject an injected fetch that ignores AbortSignal and cancel a late response",async()=>{
  let finish:(response:Response)=>void=()=>{}, cancelled=0;
  const sdk=new QCloud({apiKey:"fixture",fetch:()=>new Promise<Response>(resolve=>{finish=resolve;})});
  await assert.rejects(sdk.generation.files.upload(bytes,{timeout:20}),APITimeoutError);
  finish(new Response(new ReadableStream({cancel(){cancelled++;}}),{status:201}));
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(cancelled,1);
});

test("upload timeout does not wait for an uncooperative response cancel hook",async()=>{
  let cancelled=0;
  const sdk=new QCloud({apiKey:"fixture",fetch:async(_url,options)=>{
    const input=(options!.body as ReadableStream<Uint8Array>).getReader();
    while(!(await input.read()).done){}input.releaseLock();
    return new Response(new ReadableStream({
      start(controller){controller.enqueue(new TextEncoder().encode("{"));},
      cancel(){cancelled++;return new Promise<void>(()=>{});},
    }),{status:201});
  }});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await assert.rejects(Promise.race([
      sdk.generation.files.upload(bytes,{timeout:20}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Upload cleanup exceeded deadline")),500);}),
    ]),APITimeoutError);
    assert.equal(cancelled,1);
  }finally{clearTimeout(timer);}
});
