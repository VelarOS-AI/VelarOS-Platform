
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {localContextStorage} from '@velaros-ai/context/node'
import {nodeSubprocessCodeRunner} from '@velaros-ai/script'

import {createMcpModule,createRuntime} from '../../../dist/act/runtime/index.js'
import {createActEventProjector} from '../../../dist/act/runtime/renderer.js'

import {modelText} from './support/model-turn.mjs'
import {runtimeFrame} from './support/model-turn.mjs'
import {done,turn} from './support/model-turn.mjs'
const model=stream=>({id:'fixture',limits:{contextTokens:100000,inputTokens:90000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'exact',basis:'fixture'}),stream})
const setup=async(t,options)=>{const runtime=await createRuntime({storage:localContextStorage({path:':memory:'}),runner:nodeSubprocessCodeRunner,modules:[],...options});t.after(()=>runtime.close());return {runtime,session:await runtime.openSession('root')}}
const task=(request,source)=>turn(request,{execute:{source}})

test('unknown child effects block parent writes, completion and task switching until host reconciliation',async t=>{
 let writes=0; let childCalls=0; let main=0; let checks=0
 const module={binding:{moduleId:'probe:uncertain',instanceId:'world',generation:1,schemaRevision:'1'},summary:'world',operations:{write:{summary:'write',input:{type:'null'},output:{type:'null'},effects:'write',run:(_input,call)=>{writes++;if(writes===1)throw Error('reply lost');call.recordEffect('committed');return null},reconcile:async()=>{checks++;return {outcome:'succeeded',effect:'committed',evidence:'remote receipt confirms original operation'}}}}}
 const child=model(async function*(request){if(++childCalls===1){yield task(request,"import {write} from 'probe:uncertain';await write();");yield {type:'finish',reason:'stop'}}else yield* done(request)})
 const f=await setup(t,{modules:[module],context:{maintenance:false},agents:{concurrency:1,maxChildren:1,profiles:{writer:{model:child,modules:['probe:uncertain']}}},model:model(async function*(request){
  if(++main===1){yield task(request,"import {start,wait} from 'velaros:agents';import {write} from 'probe:uncertain';import {output} from 'velaros';const job=await start({task:'write',profile:'writer',writes:['probe:uncertain']});output(await wait({id:job.id}));await write();");yield {type:'finish',reason:'stop'}}else yield* done(request)
 })})
 const events=[];for await(const event of f.session.submit('delegate'))events.push(event)
 assert.equal(events.at(-1).status,'needs_reconcile',JSON.stringify(events));assert.equal(writes,1)
 assert.equal(events.findLast(event=>event.type==='verification').reason,'CHILD_NEEDS_RECONCILE')
 await assert.rejects(async()=>{for await(const event of f.session.submit({task:'new',text:'skip old uncertainty'})){assert.equal(typeof event.type,"string")}},{code:'NEEDS_RECONCILE'})
 await f.session.reconcile();assert.equal(writes,1);assert.equal(checks,1)
 const result=await f.session.execute({source:"import {write} from 'probe:uncertain';await write();"});assert(!result.result.failed,JSON.stringify(result));assert.equal(writes,2)
 const resumed=[];for await(const event of f.session.submit('finish'))resumed.push(event)
 assert.equal(resumed.at(-1).status,'completed');assert.equal(childCalls,2)
})

test('an orphaned durable child admission requires host reconciliation even without an in-memory worker',async t=>{
 const f=await setup(t,{context:{maintenance:false},model:model(async function*(request){yield* done(request)})})
 for await(const event of f.session.submit('initial')){assert.equal(typeof event.type,"string")}
 const taskState=await f.session.view.inspect()
 await f.session.context.append({kind:'audit',title:'act:child:orphan',body:JSON.stringify({id:'orphan',parentSessionId:'root',parentTaskId:taskState.id,sessionId:'agent:root:orphan',profile:'reader',status:'running',writes:[]})})
 const blocked=[];for await(const event of f.session.submit('continue'))blocked.push(event)
 assert.equal(blocked.at(-1).status,'needs_reconcile')
 await f.session.reconcile()
 const finished=[];for await(const event of f.session.submit('continue after checking'))finished.push(event)
 assert.equal(finished.at(-1).status,'completed')
})

test('INV-31 parent and child run the same ScriptAct loop and charge the shared root budget once per call',async t=>{
 let main=0; let children=0
 const child=model(async function*(request){children++;yield* done(request,'child evidence')})
 const f=await setup(t,{agents:{profiles:{read:{model:child,modules:[]}},concurrency:2,maxChildren:3},model:model(async function*(request){
  if(++main===1){yield task(request,"import {start,wait} from 'velaros:agents';import {output} from 'velaros';const job=await start({task:'investigate',profile:'read'});output(await wait({id:job.id}));");yield {type:'finish',reason:'stop'}}else{assert.match(modelText(request),/child-result|completed/);yield* done(request,'parent complete')}
 })})
 const events=[];for await(const e of f.session.submit('investigate'))events.push(e)
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(children,1);assert.equal(main,2)
 const usage=(await f.session.view.inspect()).usage;assert.equal(usage.mainCalls,2);assert.equal(usage.contextCalls,1)
 assert((await f.session.context.search({query:'child evidence'})).items.length>0)
 const first=await f.runtime.trace('root',{limit:1})
 assert.equal(first.turns.length,1);assert.equal(first.branches.length,1);assert.equal(first.branches[0].status,'closed')
 assert.notEqual(first.nextAfter,null)
 const second=await f.runtime.trace('root',{after:first.nextAfter,limit:1})
 assert.equal(second.turns.length,1);assert.equal(second.nextAfter,null)
 const branch=await f.runtime.trace('root',{sessionId:first.branches[0].sessionId})
 assert.equal(branch.turns.length,1);assert.match(branch.turns[0].response.body,/child evidence/)
 assert.equal(f.runtime.getSession(first.branches[0].sessionId),undefined)
 await assert.rejects(f.runtime.trace('other',{sessionId:first.branches[0].sessionId}),/不属于/)
 const small=await f.runtime.trace('root',{maxChars:64})
 assert.equal(small.turns[0].request.truncated,true)
 const bounded=small.turns[0]
 const bodyChars=[bounded.request,bounded.response,bounded.decision,...bounded.records,...bounded.invocations].reduce((sum,item)=>sum+(item?.body?.length??0),0)
 const summaryChars=(bounded.requestSummary?.system.length??0)+(bounded.requestSummary?.messages.length??0)+bounded.invocations.reduce((sum,item)=>sum+item.summary.input.length+item.summary.output.length,0)
 assert.equal(bodyChars+summaryChars,64)

})

test('shared material is copied with provenance and caller cannot forge another parent scope',async t=>{
 let calls=0; ; let childCalls=0
 const child=model(async function*(request){
  if(++childCalls===1){const frame=runtimeFrame(request.materials.at(-1).text);const file=JSON.parse(frame.goals[0].text).files[0];yield task(request,`import {memory} from 'velaros:system';const {read}=memory;import {output} from 'velaros';output(await read({ref:${JSON.stringify(file.ref)}}));`);yield {type:'finish',reason:'stop'}}else{assert.match(modelText(request),/shared-secret/);yield* done(request)}
 })
 const f=await setup(t,{agents:{profiles:{read:{model:child,modules:[]}},concurrency:1,maxChildren:2},model:model(async function*(request){if(++calls===1){yield task(request,`import {start,wait} from 'velaros:agents';import {output} from 'velaros';const a=await start({task:'read',profile:'read',materials:[${JSON.stringify(ref)}]});output(await wait({id:a.id}));const b=await start({task:'bad',profile:'read',materials:[{sessionId:'other',id:'fake'}]});output(await wait({id:b.id}));`);yield {type:'finish',reason:'stop'}}else{assert.match(modelText(request),/只能分享父任务/);yield* done(request)}})})
 const ref=(await f.session.context.append({kind:'note',title:'input.txt',body:'shared-secret'})).ref
 const events=[];for await(const e of f.session.submit('share'))events.push(e)
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(childCalls,2)
 const records=(await f.session.context.search({query:'act:child-result',limit:20})).items
 const reports=await Promise.all(records.map(r=>f.session.context.read(r.ref)))
 assert(reports.some(r=>JSON.parse(r.text).job.status==='completed'));assert(reports.some(r=>JSON.parse(r.text).job.status==='failed'))
})

test('child capability discovery and actual write dispatch use the same host scope',async t=>{
 let writes=0; let childCalls=0; let main=0
 const child=model(async function*(request){if(++childCalls===1){yield task(request,"import {write} from 'probe:world';import {output} from 'velaros';output(await write({}));");yield {type:'finish',reason:'stop'}}else {assert.match(modelText(request),/没有占用该模块/);yield* done(request)}})
 const f=await setup(t,{modules:[{binding:{moduleId:'probe:world',instanceId:'world',generation:1,schemaRevision:'1'},summary:'world',operations:{write:{summary:'write',input:{type:'object'},output:{type:'number'},effects:'write',run:(_i,call)=>{writes++;call.recordEffect('committed');return writes}}}}],agents:{profiles:{read:{model:child,modules:['probe:world']}},concurrency:1,maxChildren:2},model:model(async function*(request){if(++main===1){yield task(request,"import {start,wait} from 'velaros:agents';import {output} from 'velaros';const a=await start({task:'try write without scope claim',profile:'read'});output(await wait({id:a.id}));");yield {type:'finish',reason:'stop'}}else yield* done(request)})})
 for await(const event of f.session.submit('inspect')){assert.equal(typeof event.type,"string")}
 assert.equal(writes,0);assert.equal(childCalls,2)
})

test('child reservations cannot exceed the root model budget',async t=>{
 let main=0; let childCalls=0
 const child=model(async function*(request){childCalls++;yield* done(request)})
 const f=await setup(t,{context:{sources:[],limits:{modelCalls:2}},agents:{profiles:{read:{model:child,modules:[]}},concurrency:1,maxChildren:2},model:model(async function*(request){main++;yield task(request,"import {start,wait} from 'velaros:agents';const a=await start({task:'one',profile:'read'});await wait({id:a.id});");yield {type:'finish',reason:'stop'}})})
 const events=[];for await(const e of f.session.submit('bounded'))events.push(e)
 assert.equal(main,1);assert.equal(childCalls,1);assert.equal(events.at(-1).status,'failed');assert.match(events.findLast(e=>e.type==='error').message,/预算/)
})

test('renderer distinguishes preview, rejected generation and accepted body; replay is idempotent',()=>{
 const p=createActEventProjector();let sequence=0
 const apply=event=>p.apply({sessionId:'a',runId:'r',sequence:++sequence,event:{runId:'r',...event}})
 apply({type:'turn',turnId:'a'});apply({type:'text',text:'unsafe preview'});assert.equal(p.snapshot().runs.r.messages.length,0)
 apply({type:'rejected',turnId:'a',message:'bad protocol'});assert.equal(p.snapshot().runs.r.preview,'')
 apply({type:'turn',turnId:'b'});const state=apply({type:'accepted',turnId:'b',text:'ready',ref:{sessionId:'a',id:'raw'}})
 assert.equal(state.runs.r.messages.length,1);assert.throws(()=>p.apply({sessionId:'other',runId:'r',sequence:99,event:{type:'text',runId:'r',text:'foreign'}}),/混用会话/);assert.deepEqual(p.apply({sessionId:'a',runId:'r',sequence:1,event:{type:'text',runId:'r',text:'late'}}),state)
})

test('MCP annotations alone cannot grant observation or bypass write approval',async t=>{
 let calls=0
 const connection={connect:async()=>{},close:async()=>{},callTool:async()=>{calls++;return {content:[{type:'text',text:'ok'}]}}}
 const module=createMcpModule({binding:{moduleId:'probe:mcp',instanceId:'mcp',generation:1,schemaRevision:'1'},connection,tools:[{name:'doWork',description:'remote',inputSchema:{type:'object'},annotations:{title:null,readOnlyHint:true,destructiveHint:false,idempotentHint:true}}]})
 const f=await setup(t,{modules:[module]});await f.session.context.append({kind:'user',body:'mcp'})
 await f.session.observe({source:"import {doWork} from 'probe:mcp';await doWork({});"})
 const observed=await f.session.execute({source:"import {doWork} from 'probe:mcp';await doWork({});"})
 assert.equal(observed.checked,true);assert.match(observed.result.failed.message,/需要宿主授权/);assert.equal(calls,0)
})

test('an incremental child uses history through the same runtime without configuring advanced search',async t=>{
 let childCalls=0; let main=0
 const child=model(async function*(request){
  assert(Array.isArray(request.history))
  if(++childCalls===1){const ref=runtimeFrame(request.materials.at(-1).text).goals[0].record.ref;yield task(request,`import {memory as memoryApi} from 'velaros:system';const {read}=memoryApi;import {output} from 'velaros';output(await read({ref:${JSON.stringify(ref)}}));`);yield {type:'finish',reason:'stop'}}else{assert.match(JSON.stringify(request.history),/incremental target/);yield* done(request)}
 })
 const f=await setup(t,{agents:{profiles:{read:{model:child,memory:{recentRecords:64},modules:[]}},concurrency:1,maxChildren:2},model:model(async function*(request){if(++main===1){yield task(request,"import {start,wait} from 'velaros:agents';import {output} from 'velaros';const job=await start({task:'incremental target',profile:'read'});output(await wait({id:job.id}));");yield {type:'finish',reason:'stop'}}else{const frame=runtimeFrame(request.materials.at(-1).text);assert.equal(frame.children[0].status,'completed');yield* done(request)}})})
 const events=[];for await(const e of f.session.submit('delegation'))events.push(e)
 assert.equal(childCalls,2);assert.equal(events.at(-1).status,'completed',JSON.stringify(events))
})

test('parent cancellation waits for a child reservation to return before releasing the root lease',{timeout:5000},async t=>{
 const entered=Promise.withResolvers(); const release=Promise.withResolvers()
 let childCalls=0
 const child=model(async function*(request){childCalls++;yield* done(request)})
 const f=await setup(t,{agents:{profiles:{read:{model:child,modules:[]}},concurrency:1,maxChildren:2},model:model(async function*(request){
  yield task(request,"import {start,wait} from 'velaros:agents';const job=await start({task:'inspect',profile:'read'});await wait({id:job.id});");yield {type:'finish',reason:'stop'}
 })})
 const reserve=f.session.view.reserveModel.bind(f.session.view)
 f.session.view.reserveModel=async(role,tokens)=>{await reserve(role,tokens);if(role==='context'){entered.resolve();await release.promise}}
 const controller=new AbortController(); const events=[]
 const pending=(async()=>{for await(const event of f.session.submit('Inspect',controller.signal))events.push(event)})()
 await entered.promise;controller.abort()
 await new Promise(resolve=>setTimeout(resolve,50))
 release.resolve();await pending
 assert.equal(events.at(-1).status,'cancelled',JSON.stringify(events))
 const state=await f.session.view.inspect()
 assert.equal(childCalls,0);assert.equal(state.usage.contextCalls,0);assert.equal(state.lease,null)
})

test('child questions interrupt parent wait and replies resume the original script exactly once',{timeout:15000},async t=>{
 let main=0; let childCalls=0; let answered=0
 const child=model(async function*(request){
  if(++childCalls===1){yield task(request,"import {ask} from 'velaros:interaction';import {output} from 'velaros';output(await ask({message:'Which environment?'}));");yield {type:'finish',reason:'stop'}}else{assert.match(modelText(request),/staging/);answered++;yield* done(request,'finished after answer')}
 })
 const f=await setup(t,{context:{maintenance:false},agents:{profiles:{read:{model:child,modules:[]}},concurrency:1,maxChildren:1},model:model(async function*(request){
  main++
  if(main===1){yield task(request,"import {start,wait} from 'velaros:agents';import {output} from 'velaros';const job=await start({task:'ask before proceeding',profile:'read'});output(await wait({id:job.id}));");yield {type:'finish',reason:'stop'}}
  else if(main===2){const job=runtimeFrame(request.materials.at(-1).text).children[0];assert.equal(job.status,'waiting');assert.equal(job.pending[0].message,'Which environment?');yield task(request,`import {reply,wait} from 'velaros:agents';import {output} from 'velaros';await reply({id:${JSON.stringify(job.id)},requestId:${JSON.stringify(job.pending[0].id)},value:'staging'});output(await wait({id:${JSON.stringify(job.id)}}));`);yield {type:'finish',reason:'stop'}}
  else yield* done(request)
 })})
 const events=[];for await(const event of f.session.submit('investigate'))events.push(event)
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(childCalls,2);assert.equal(answered,1);assert.equal(main,3)
})
test('same child resumes with newly granted writes and store access without resetting identity',{timeout:15000},async t=>{
 let main=0; let childCalls=0; let writes=0; let childId;
 const module={binding:{moduleId:'probe:grant',instanceId:'world',generation:1,schemaRevision:'1'},summary:'world',operations:{write:{summary:'write',input:{type:'null'},output:{type:'number'},effects:'write',run:(_input,call)=>{writes++;call.recordEffect('committed');return writes}}}}
 const child=model(async function*(request){
  if(++childCalls===1)yield* done(request,'need write phase')
  else if(childCalls===2){yield task(request,`import {write} from 'probe:grant';import {store} from 'velaros:system';import {output} from 'velaros';await write();output(await store.set({store:${JSON.stringify(storeId)},key:'result',baseRevision:0,value:'done'}));`);yield {type:'finish',reason:'stop'}}else yield* done(request)
 })
 const f=await setup(t,{modules:[module],context:{maintenance:false},agents:{profiles:{reader:{model:child,modules:[]},writer:{model:child,modules:['probe:grant']}},concurrency:1,maxChildren:1},model:model(async function*(request){
  if(++main===1){yield task(request,"import {start,wait} from 'velaros:agents';import {output} from 'velaros';const job=await start({task:'investigate',profile:'reader'});output(await wait({id:job.id}));");yield {type:'finish',reason:'stop'}}
  else if(main===2){const job=runtimeFrame(request.materials.at(-1).text).children[0];childId=job.sessionId;yield task(request,`import {resume,wait} from 'velaros:agents';import {output} from 'velaros';const job=await resume({id:${JSON.stringify(job.id)},input:'implement',profile:'writer',writes:['probe:grant'],stores:[{store:${JSON.stringify(storeId)},read:[''],write:['']}]});output(await wait({id:job.id}));`);yield {type:'finish',reason:'stop'}}
  else{const job=runtimeFrame(request.materials.at(-1).text).children[0];assert.equal(job.sessionId,childId);assert.equal(job.status,'completed');yield* done(request)}
 })})
 await f.session.context.append({kind:'user',body:'prepare shared work'})
 const created=await f.session.execute({source:"import {store} from 'velaros:system';import {output} from 'velaros';output(await store.create({name:'shared'}));"});const storeId=created.result.value.default.id
 const events=[];for await(const event of f.session.submit('read then implement'))events.push(event)
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(writes,1);assert.equal(childCalls,3)
 assert.equal((await f.session.view.inspect()).usage.contextCalls,3)
})

test('INV-38 live projection clears rejected, cancelled and interrupted previews while retaining accepted text',()=>{
 for(const status of ['cancelled','failed','context_blocked','needs_reconcile','completed']){
  const p=createActEventProjector()
  p.applyLive({type:'turn',runId:'r',turnId:'first'})
  p.applyLive({type:'accepted',runId:'r',turnId:'first',text:'kept',ref:{sessionId:'s',id:'one'}})
  p.applyLive({type:'turn',runId:'r',turnId:'second'})
  p.applyLive({type:'text',runId:'r',text:'partial'})
  const state=p.applyLive({type:'state',runId:'r',status})
  assert.equal(state.runs.r.preview,'');assert.equal(state.runs.r.messages[0].text,'kept')
  assert.deepEqual(p.applyLive({type:'text',runId:'r',text:'late'}),state)
 }
 const p=createActEventProjector()
 p.applyLive({type:'turn',runId:'r',turnId:'t'})
 p.applyLive({type:'text',runId:'r',text:'partial'})
 assert.equal(p.finish().runs.r.preview,'')
 assert.equal(p.applyLive({type:'text',runId:'r',text:'late'}).runs.r.preview,'')
})

test('live and persisted projection share accepted identities without duplicate bodies or revived previews',()=>{
 const p=createActEventProjector();const accepted={type:'accepted',runId:'r',turnId:'t',text:'answer',ref:{sessionId:'s',id:'ref'}}
 p.applyLive({type:'turn',runId:'r',turnId:'t'});p.applyLive({type:'text',runId:'r',text:'candidate'})
 p.applyLive(accepted)
 const state=p.apply({sessionId:'s',runId:'r',sequence:10,event:accepted})
 assert.equal(state.runs.r.messages.length,1);assert.equal(state.cursor,10)
 assert.deepEqual(p.applyLive({type:'text',runId:'r',text:'late'}),state)
 p.applyLive({type:'turn',runId:'r',turnId:'next'})
 p.applyLive({type:'text',runId:'r',text:'invalid'})
 p.applyLive({type:'error',runId:'r',message:'broken'})
 assert.equal(p.applyLive({type:'text',runId:'r',text:'late'}).runs.r.preview,'')
 assert.equal(p.snapshot().runs.r.messages[0].text,'answer')
})
