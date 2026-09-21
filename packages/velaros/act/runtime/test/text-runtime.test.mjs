
import assert from 'node:assert/strict'
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import {modelText} from './support/model-turn.mjs'
import {runtimeFrame} from './support/model-turn.mjs'
import { done,marker } from './support/model-turn.mjs'

const block=(request,head,source='')=>`${marker(request)} ${head}\n${source}${source?'\n':''}${marker(request)}\n`
const finish={type:'finish',reason:'stop'}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check){const deadline=Date.now()+4000;while(!await check()){assert(Date.now()<deadline,'test condition timed out');await wait(5)}}
async function fixture(t,stream,extra={}){
 const root=await mkdtemp(join(tmpdir(),'scriptact-text-')); const storage=localContextStorage({path:join(root,'state.sqlite')})
 const f={root,frames:[],calls:0,writes:[],started:[],reads:0,release:()=>{},activeWrites:0,maxWrites:0}
 const barrier=new Promise(resolve=>{f.release=resolve})
 const model={id:'text-test',limits:{contextTokens:200000,inputTokens:180000,outputTokens:4000},estimate:async()=>({tokens:1000,precision:'exact',basis:'test'}),async *stream(request){f.frames.push(runtimeFrame(request.materials.at(-1).text));f.calls++;yield* stream(request,f)}}
 const module={binding:{moduleId:'test:ops',instanceId:'ops',generation:1,schemaRevision:'1'},summary:'controlled test host',operations:{
  read:{summary:'read',effects:'none',input:{type:'null'},output:{type:'integer'},run:()=>++f.reads},
  wait:{summary:'barrier',effects:'none',input:{type:'integer'},output:{type:'integer'},run:async value=>{f.started.push(value);await barrier;return value}},
  write:{summary:'write',effects:'write',input:{type:'string'},output:{type:'null'},run:async value=>{f.activeWrites++;f.maxWrites=Math.max(f.maxWrites,f.activeWrites);await wait(15);f.writes.push(value);await writeFile(join(root,'result.txt'),value);f.activeWrites--;return null}},
 }}
 const runtime=await createRuntime({storage,runner:nodeSubprocessCodeRunner,model,modules:[module],...extra}); const session=await runtime.openSession('s')
 Object.assign(f,{runtime,session,storage,programs:new ProgramContext('s',session.context,storage)})
 t.after(async()=>{f.release();await runtime.close();await rm(root,{recursive:true,force:true})})
 return f
}
async function collect(f,input='Continue',signal){const events=[];for await(const event of f.session.submit(input,signal))events.push(event);return events}
const assertDone=events=>assert.equal(events.at(-1).status,'completed',JSON.stringify(events))
const write="import {write} from 'test:ops';await write('one');"

test('INV-13 two identical execute blocks both run once, in order, with separate identities',async t=>{
 const f=await fixture(t,async function*(request,f){if(f.calls===1){yield {type:'text',text:block(request,'execute',write)+block(request,'execute()',write)};yield finish}else yield* done(request)})
 assertDone(await collect(f));assert.deepEqual(f.writes,['one','one']);assert.equal(f.maxWrites,1)
 const jobs=f.frames[1].jobs;assert.equal(jobs.length,2);assert.notEqual(jobs[0].executionId,jobs[1].executionId)
 assert.equal(f.frames[1].results.length,2)
})

test('INV-14 opaque blobs and host input arrive unchanged and frozen inside the real JS runner',async t=>{
 const payload='const value = `Hello, ${name}`;\n```html\n<div title="quoted">世界</div>\n```\n'
 const inputs={target:{path:'result.txt'}}
 const f=await fixture(t,async function*(request,f){
  if(f.calls===1){inputs.target.path='changed-after-frame';yield {type:'text',text:`Before\n${block(request,'blobs("payload")',payload)}${block(request,'execute({inputRef:"host:target"})',`import {input,blobs} from 'velaros:program';import {write} from 'test:ops';import {output} from 'velaros';output({frozen:Object.isFrozen(input),path:input.path});await write(blobs.payload);`)}After\n`};yield finish}
  else{assert(modelText(request).includes("import {input,blobs}"));yield* done(request)}
 },{inputs:()=>inputs})
 const events=await collect(f);assertDone(events);assert.equal(await readFile(join(f.root,'result.txt'),'utf8'),payload)
 assert.equal(events.filter(event=>event.type==='text').map(event=>event.text).join(''),'Before\nAfter\n')
 assert.match(f.frames[1].results[0].text,/"frozen":true/);assert.match(f.frames[1].results[0].text,/result.txt/)
})

test('whole-response preflight rejects later invalid code without executing an earlier valid block',async t=>{
 const f=await fixture(t,async function*(request,f){if(f.calls===1){yield {type:'text',text:block(request,'execute',write)+block(request,'execute','const = ;')};yield finish}else yield* done(request)})
 assertDone(await collect(f));assert.deepEqual(f.writes,[]);assert.match(f.frames[1].results[0].text,/SCRIPT_CHECK/)
})

test('background reads overlap, plain Markdown waits for events, and completion waits for real results',async t=>{
 let afterWait=false
 const f=await fixture(t,async function*(request,f){
  if(f.calls===1){yield {type:'text',text:[1,2].map(n=>block(request,'execute({async:true})',`import {wait} from 'test:ops';import {output} from 'velaros';output(await wait(${n}));`)).join('')};yield finish}
  else if(f.calls===2){await until(()=>f.started.length===2);setTimeout(()=>{afterWait=true;f.release()},40);yield {type:'text',text:'Waiting for the results.'};yield finish}
  else{assert(afterWait);yield* done(request)}
 })
 const events=await collect(f);assertDone(events);assert(events.some(event=>event.type==='state'&&event.status==='waiting'));assert(f.calls<=5)
 assert.equal(f.frames.at(-1).results.length,2)
})

test('a retain=1 background result arriving during model generation survives that frame acknowledgement',async t=>{
 const f=await fixture(t,async function*(request,f){
  if(f.calls===1){yield {type:'text',text:block(request,'execute({async:true,retain:1})',"import {wait} from 'test:ops';import {output} from 'velaros';output(await wait(7));")};yield finish}
  else if(f.calls===2){assert.equal(f.frames.at(-1).results.length,0);await until(()=>f.started.length===1);f.release();await until(async()=>(await f.programs.state()).leases.length===1);yield* done(request)}
  else{assert.equal(f.frames.at(-1).results.length,1);assert.equal(f.frames.at(-1).results[0].remainingTurns,1);yield* done(request)}
 })
 assertDone(await collect(f));assert.equal(f.calls,3);assert.equal((await f.programs.state()).leases.length,0)
})

test('protocol repair reuses the frame and does not rerun stable observation',async t=>{
 const tags=[]
 const f=await fixture(t,async function*(request,f){tags.push(marker(request));if(f.calls===1){yield {type:'text',text:`${marker(request)} invalid()`};yield finish}else yield* done(request)})
 await f.session.observe({source:"import {read} from 'test:ops';import {output} from 'velaros';output(await read());"})
 assertDone(await collect(f));assert.equal(f.reads,1);assert.equal(tags[0],tags[1]);assert.equal(f.frames[0].programFrame.id,f.frames[1].programFrame.id)
})

test('explicit observation clear removes the next-frame rerun',async t=>{
 const f=await fixture(t,async function*(request,f){if(f.calls===1){yield {type:'text',text:block(request,'observe({clear:true})')};yield finish}else yield* done(request)})
 await f.session.observe({source:"import {read} from 'test:ops';await read();"})
 assertDone(await collect(f));assert.equal(f.reads,1);assert.equal(f.frames[1].observation.sourceRef,null)
})

test('work narration without a decision exhausts bounded repair without claiming completion',async t=>{
 const f=await fixture(t,async function*(){yield {type:'text',text:'Please choose a destination.'};yield finish})
 const events=await collect(f);assert.equal(events.at(-1).status,'failed');assert.equal(f.calls,3);assert.notEqual((await f.session.view.inspect()).status,'completed');assert.deepEqual(f.writes,[])
})

test('user-only image input remains multimodal across calls and is recorded as user evidence',async t=>{
 const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
 const f=await fixture(t,async function*(request){assert.equal(request.images[0].data,data);assert.equal(request.images[0].origin,'user');assert(!modelText(request).includes(data));yield* done(request)})
 assertDone(await collect(f,{images:[{type:'image-data',mediaType:'image/png',data,label:'pixel'}]}))
 assertDone(await collect(f,'Describe that image again'))
})

test('concurrent writes are serialized at the shared capability boundary',async t=>{
 const f=await fixture(t,async function*(request,f){if(f.calls===1){yield {type:'text',text:block(request,'execute({async:true})',write)+block(request,'execute({async:true})',write)};yield finish}else yield* done(request)})
 assertDone(await collect(f));assert.equal(f.writes.length,2);assert.equal(f.maxWrites,1)
})

test('a short ownership lease is renewed while a background task runs',async t=>{
 const f=await fixture(t,async function*(request,f){if(f.calls===1){yield {type:'text',text:block(request,'execute({async:true})',"import {wait} from 'test:ops';await wait(1);")};yield finish}else if(f.calls===2){await until(()=>f.started.length===1);await wait(4500);f.release();yield* done(request)}else yield* done(request)},{context:{sources:[],limits:{leaseMs:2000}}})
 assertDone(await collect(f));assert.equal((await f.session.view.inspect()).lease,null)
})

test('renewal during an in-flight frame preserves the newly granted exposure',async t=>{
 const f=await fixture(t,async function*(request,f){
  if(f.calls===1){const ref=f.frames[0].results[0].ref;await f.programs.retain(ref,1);yield* done(request)}
  else yield* done(request)
 })
 await f.session.context.append({kind:'user',body:'Keep this result'})
 await f.session.execute({source:"import {output} from 'velaros';output('keep');"},1)
 assertDone(await collect(f));assert.equal((await f.programs.state()).leases.length,1)
 assertDone(await collect(f));assert.equal(f.frames[1].results[0].remainingTurns,1);assert.equal((await f.programs.state()).leases.length,0)
})

test('cancelling an async job stops later dispatch and releases the task lease',async t=>{
 const controller=new AbortController()
 const f=await fixture(t,async function*(request,f){
  if(f.calls===1){yield {type:'text',text:block(request,'execute({async:true})',"import {wait,write} from 'test:ops';await wait(1);await write('late');")};yield finish}
  else{await until(()=>f.started.length===1);controller.abort();setTimeout(f.release,20);yield* done(request)}
 })
 const events=await collect(f,'cancel',controller.signal);assert.equal(events.at(-1).status,'cancelled');await wait(80)
 assert.equal(f.writes.length,0);assert.equal((await f.session.view.inspect()).lease,null)
 assert(!(await f.programs.state()).jobs.some(job=>['queued','running'].includes(job.status)))
})

test('a synchronous runtime failure cancels the unstarted remainder of its batch',async t=>{
 const f=await fixture(t,async function*(request,f){if(f.calls===1){yield {type:'text',text:block(request,'execute','throw new Error("stop batch");')+block(request,'execute',write)};yield finish}else yield* done(request)})
 assertDone(await collect(f));assert.equal(f.writes.length,0);assert(f.frames[1].jobs.some(job=>job.status==='cancelled'))
})

test('reconciliation recovers persisted queued and completed jobs without replaying source',async t=>{
 const f=await fixture(t,async function*(request){yield* done(request)})
 const goal=await f.session.context.append({kind:'user',body:'Recover saved jobs'})
 const completed=await f.session.execute({source:write})
 await f.programs.job({executionId:completed.executionId,sourceRef:completed.sourceRef,batchId:'interrupted',status:'running'})
 const queued=crypto.randomUUID();await f.programs.job({executionId:queued,sourceRef:completed.sourceRef,batchId:'interrupted',status:'queued'})
 await f.session.view.begin(goal.ref);await f.session.view.startStep(completed.executionId,undefined,true);await f.session.view.end()
 await f.session.reconcile()
 assert.equal(f.writes.length,1)
 const state=await f.programs.state();assert.equal(state.jobs.find(job=>job.executionId===completed.executionId).status,'succeeded');assert.equal(state.jobs.find(job=>job.executionId===queued).status,'cancelled')
 assert.deepEqual((await f.session.view.inspect()).activeExecutions,{})
 assertDone(await collect(f));assert.equal(f.writes.length,1)
})

test('raw blob names and nested input keys keep JSON semantics in the isolated runner',async t=>{
 const f=await fixture(t,async function*(request,f){if(f.calls===1){yield {type:'text',text:block(request,'blobs("__proto__")','literal data')+block(request,'execute({input:{"__proto__":{safe:1}}})',"import {input,blobs} from 'velaros:program';import {output} from 'velaros';output({blob:blobs['__proto__'],owned:Object.hasOwn(input,'__proto__'),frozen:Object.isFrozen(input['__proto__']),polluted:({}).safe===1});")};yield finish}else yield* done(request)})
 assertDone(await collect(f));const text=f.frames[1].results[0].text
 assert.match(text,/"blob":"literal data"/);assert.match(text,/"owned":true/);assert.match(text,/"frozen":true/);assert.match(text,/"polluted":false/)
})


test('missing work decision is repaired before a single actual write and completion',async t=>{
 const f=await fixture(t,async function*(request,f){
  if(f.calls===1){yield {type:'text',text:'I will continue the task.'};yield finish}
  else if(f.calls===2){assert.equal(f.writes.length,0);yield {type:'text',text:block(request,'execute',"import {write} from 'test:ops';await write('recovered');")};yield finish}
  else yield* done(request)
 })
 assertDone(await collect(f));assert.equal(f.calls,3);assert.deepEqual(f.writes,['recovered'])
 const state=await f.storage.load('s')
 const decisions=await Promise.all(state.records.filter(record=>record.title==='model-response').map(record=>f.storage.get('s',record.objectId).then(JSON.parse)))
 assert.equal(decisions[0].status,'rejected');assert.equal(decisions[1].status,'accepted')
})
