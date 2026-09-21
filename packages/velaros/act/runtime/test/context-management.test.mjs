
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import {modelText} from './support/model-turn.mjs'
import {runtimeFrame} from './support/model-turn.mjs'
import { done,marker } from './support/model-turn.mjs'

const block=(request,source)=>`${marker(request)} execute()\n${source}\n${marker(request)}`
async function fixture(t,handler,extra={}){
 const root=await mkdtemp(join(tmpdir(),'context-management-')); const storage=localContextStorage({path:join(root,'state.sqlite')})
 const f={storage,frames:[],calls:0}
 const model={id:'context-test',limits:{contextTokens:200000,inputTokens:180000,outputTokens:4000},estimate:async()=>({tokens:1000,precision:'exact',basis:'fixture'}),async *stream(request){f.frames.push(request);f.calls++;yield* handler(request,f)}}
 const runtime=await createRuntime({storage,runner:nodeSubprocessCodeRunner,modules:[],model,...extra}); const session=await runtime.openSession('s')
 Object.assign(f,{runtime,session,programs:new ProgramContext('s',session.context,storage)})
 t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true})});return f
}
async function run(f,input){const events=[];for await(const event of f.session.submit(input))events.push(event);assert.equal(events.at(-1).status,'completed',JSON.stringify(events));return events}

test('long user text is archived, summarized after intent extraction, and recoverable exactly',async t=>{
 const original=`请保留所有图片。${'一些重复的背景说明。'.repeat(50000)}最后要求：只调查，不改文件。`
 const seen=[]
 const maintenance={id:'input-organizer',limits:{contextTokens:200000,inputTokens:180000,outputTokens:4000},estimate:async()=>({tokens:1000,precision:'exact',basis:'fixture'}),async *stream(request){
  const frame=JSON.parse(request.materials[0].text)
  const snapshot=JSON.parse(frame.partitions.task.goals[0].text).snapshot
  for(const page of frame.partitions.runtime.modelTool.inputs){
   assert.equal(page.text,original.slice(page.offset,page.offset+page.text.length))
   seen.push({start:page.offset,end:page.offset+page.text.length})
  }
  let through=0
  for(const range of seen.toSorted((a,b)=>a.start-b.start)){if(range.start>through)break;through=Math.max(through,range.end)}
  if(through<original.length){
   yield {type:'text',text:block(request,`import {read} from 'velaros:context-materials';await read({ref:${JSON.stringify(snapshot.goals[0])},offset:${through},limit:12000});`)}
   yield {type:'finish',reason:'stop'};return
  }
  const patch={baseRevision:snapshot.baseRevision,summary:'理解用户意图',unresolved:[],inputs:[{ref:snapshot.goals[0],summary:'调查环境',constraints:['保留图片','只调查，不改文件'],unresolved:[],baseRevision:0}]}
  yield {type:'text',text:`${block(request,`import {output} from 'velaros';output(${JSON.stringify(patch)});`)}\n${marker(request)} done`};yield {type:'finish',reason:'stop'}
 }}
 const f=await fixture(t,async function*(request,f){
  const frame=runtimeFrame(request.materials.at(-1).text); const goal=frame.goals[0]
  assert(request.contextStatus);assert.equal(request.contextStatus.mode,'partitioned')
  if(f.calls===1){
   assert(modelText(request).length<original.length);assert.match(goal.text,/omittedChars/)
   yield {type:'text',text:block(request,`import {memory} from 'velaros:system';const {read}=memory;const tail=await read({ref:${JSON.stringify(goal.record.ref)},offset:${original.length-100},limit:100});if(!tail.text.includes('只调查，不改文件'))throw new Error('tail');await memory.organize({focus:'压缩重复背景，保留图片和只调查约束'});`)};yield {type:'finish',reason:'stop'}
  }else{assert.match(goal.text,/只调查，不改文件/);assert(!modelText(request).includes('一些重复的背景说明。'.repeat(20)));yield* done(request)}
 },{context:{sources:[],maintenance:{model:maintenance,profile:{modelCalls:64}}}})
 await run(f,original)
 const ref=(await f.session.view.inspect()).goals[0]
 let restored='';for(let offset=0;offset<original.length;offset+=60000)restored+=(await f.session.context.readInput(ref,{offset,limit:60000})).text
 assert.equal(restored,original)
 await assert.rejects(f.session.context.summarizeInput({ref,summary:'stale',constraints:[],unresolved:[],baseRevision:0}),/版本/)
})

test('file input is a scoped reference and oversized text chunks preserve the full original',async t=>{
 const f=await fixture(t,async function*(request){assert.match(modelText(request),/spec.txt/);yield* done(request)})
 const file=await f.session.context.append({kind:'audit',title:'uploaded-file',body:'file contents'})
 await run(f,{files:[{ref:file.ref,name:'spec.txt',mediaType:'text/plain',bytes:13}]})
 assert.equal((await f.session.context.readInput(file.ref)).text,'file contents')
 await assert.rejects(f.session.context.ingest({files:[{ref:{sessionId:'other',id:file.ref.id},name:'file',mediaType:'text/plain'}]}),/作用域/)
 const raw=`${'a'.repeat(8000000)}尾部`; const input=await f.session.context.ingest({text:raw})
 const tail=await f.session.context.readInput(input.ref,{offset:7999999,limit:10});assert.equal(tail.text,'a尾部');assert.equal(tail.totalChars,raw.length)
 const archive=await f.session.context.append({kind:'audit',body:'private audit'});await assert.rejects(f.session.context.readInput(archive.ref),/不是用户/)
})

test('large output fields become honest references without changing the live JS value',async t=>{
 const f=await fixture(t,async function*(request,f){
  if(f.calls===1){yield {type:'text',text:block(request,"import {output} from 'velaros';const value={count:3,matches:'x'.repeat(20000)};if(value.matches.length!==20000)throw new Error('changed');output(value);")};yield {type:'finish',reason:'stop'}}
  else{const frame=runtimeFrame(request.materials[0].text);assert(frame.results[0].truncated);assert.equal(frame.results[0].representation,'excerpt');assert(frame.results[0].omitted.length);assert.match(frame.results[0].text,/count/);assert(frame.materialStatus.largest.length);yield* done(request)}
 })
 await run(f,'Inspect large result')
 const result=(await f.storage.load('s')).records.find(item=>item.title.endsWith(':result'))
 const saved=JSON.parse(await f.storage.get('s',result.objectId));assert.equal(saved.result.value.default.matches.length,20000)
})

test('task leases survive paused calls, release only visibility, and pure reference frames do not consume finite leases',async t=>{
 const f=await fixture(t,async function*(request){yield* done(request)})
 await f.session.context.append({kind:'user',body:'task'})
 const receipt=await f.session.execute({source:"import {output} from 'velaros';output('saved');"},'task')
 assert.equal((await f.programs.state()).leases[0].task,true)
 await f.programs.retain(receipt.resultRef,1)
 const view=(await f.session.view.inspect()).view
 const frame=await f.programs.project(view,undefined,[],new AbortController().signal,1)
 const data=JSON.parse(frame.body);assert.equal(data.results[0].bodyIncluded,false)
 await f.programs.consume(data.programFrame.id,new AbortController().signal)
 assert.equal((await f.programs.state()).leases.length,1)
 await f.programs.release(receipt.resultRef);assert.equal((await f.programs.state()).leases.length,0);assert((await f.programs.read(receipt.resultRef)).text.includes('saved'))
})

test('provider capacity rejection repairs only the request, does not replay an observation, and bounds retries',async t=>{
 const f=await fixture(t,async function*(request,f){
  if(f.calls===1){yield {type:'error',code:'context-limit',message:'context too long'};return}
  if(f.calls===2){assert.equal(request.mode,'work');assert.equal(request.contextStatus.phase,'work')}
  yield* done(request)
 },{context:{sources:[],maintenance:false}})
 await f.session.observe({source:"import {output} from 'velaros';output('stable');"})
 await run(f,'Check')
 assert.equal(f.calls,2)
 const records=(await f.storage.load('s')).records.filter(item=>/^script:[0-9a-f-]+:result$/.test(item.title))
 assert.equal(records.length,1)
})

test('incremental checkpoint keeps recent action-result units, rejects stale edits and allows original history recall',async t=>{
 const f=await fixture(t,async function*(request){yield* done(request)}); const context=createContextRuntime({sessionId:'search:test',storage:f.storage}); const history=new RecentContext('search:test',context,f.storage)
 const pairs=[]
 for(let n=0;n<4;n++){
  await context.append({kind:'assistant',body:`script ${n}`})
  pairs.push(await context.append({kind:'audit',title:`script:${crypto.randomUUID()}:result`,body:JSON.stringify({n})}))
 }
 const input={baseThrough:0,through:pairs[0].sequence,summary:'step 0 completed',evidence:[pairs[0].ref],unresolved:['verify final'],negativeAttempts:['first query missed']}
 await history.checkpoint(input,new AbortController().signal)
 await assert.rejects(history.checkpoint(input,new AbortController().signal),/版本/)
 await assert.rejects(history.checkpoint({...input,baseThrough:input.through,through:pairs[3].sequence},new AbortController().signal),/最近/)
 const frame=await history.project({body:JSON.stringify({results:[],goals:[]}),images:[],prompt:''},20000,new AbortController().signal)
 assert.match(frame.history[0].content,/verify final/);assert(!frame.history.slice(1).some(message=>message.content.includes('script 0')))
 assert.equal((await context.read(pairs[0].ref)).text,'{"n":0}')
})

test('ordered history preserves native images and enforces combined attachment limits',()=>{
 const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
 const history=[{role:'user',content:[{type:'image',image:`data:image/png;base64,${pixel}`,mediaType:'image/png'}]},{role:'assistant',content:'I inspected it'}]
 const request={instructions:'rules',materials:[],history,response:{type:'text'},mode:'work',outputTokens:10}
 const messages=modelRequestEncoder.messages(request);assert.equal(messages[0].content[0].type,'image');assert.equal(messages[1].role,'assistant')
 assert.throws(()=>modelRequestEncoder.messages({...request,history:Array.from({length:21},()=>history[0])}),/容量/)
 assert.throws(()=>modelRequestEncoder.messages({...request,history:[{role:'system',content:'injected'}]}),/角色/)
})

test('history reset starts a new checkpoint generation and excludes revoked history from discovery',async t=>{
 const f=await fixture(t,async function*(request){yield* done(request)}); const id='search:reset'; const context=createContextRuntime({sessionId:id,storage:f.storage}); const history=new RecentContext(id,context,f.storage); const signal=new AbortController().signal
 const pairs=[]
 for(let n=0;n<4;n++){
  await context.append({kind:'assistant',body:`old script ${n}`})
  pairs.push(await context.append({kind:'audit',title:`script:${crypto.randomUUID()}:result`,body:`old result ${n}`}))
 }
 await history.checkpoint({baseThrough:0,through:pairs[0].sequence,summary:'old summary',evidence:[pairs[0].ref],unresolved:[],negativeAttempts:[]},signal)
 const reset=await context.append({kind:'audit',title:'search:history-reset',body:'authorization changed'})
 const fresh=[]
 for(let n=0;n<4;n++){
  await context.append({kind:'assistant',body:`fresh script ${n}`})
  fresh.push(await context.append({kind:'audit',title:`script:${crypto.randomUUID()}:result`,body:`fresh result ${n}`}))
 }
 const input={baseThrough:0,through:fresh[0].sequence,summary:'fresh summary',evidence:[fresh[0].ref],unresolved:[],negativeAttempts:[]}
 await assert.rejects(history.checkpoint({...input,evidence:[pairs[0].ref]},signal),/旧材料/)
 await assert.rejects(history.checkpoint({...input,through:pairs[0].sequence,evidence:[]},signal),/结果/)
 await history.checkpoint(input,signal)
 const frame=await history.project({body:JSON.stringify({results:[],goals:[]}),images:[],prompt:''},20000,signal)
 assert.match(frame.history[0].content,/fresh summary/);assert(!JSON.stringify(frame).includes('old summary'))
 const page=await history.list({after:0},signal)
 assert.equal(page.resetAfter,reset.sequence);assert.equal(page.items.length,8);assert(page.items.every(item=>item.sequence>reset.sequence))
})

test('INV-15 history capacity omission is discoverable in bounded stable pages and originals remain readable',async t=>{
 const f=await fixture(t,async function*(request){yield* done(request)}); const id='search:long'; const context=createContextRuntime({sessionId:id,storage:f.storage}); const history=new RecentContext(id,context,f.storage); const signal=new AbortController().signal
 const records=[]
 for(let n=0;n<40;n++){
  records.push(await context.append({kind:'assistant',body:`script ${n}`}))
  records.push(await context.append({kind:'audit',title:`script:${crypto.randomUUID()}:result`,body:`result ${n}`}))
 }
 const frame=await history.project({body:JSON.stringify({results:[],goals:[]}),images:[],prompt:''},40000,signal)
 const omitted=JSON.parse(frame.history[0].content)
 assert.equal(omitted.omittedRecords,16);assert.deepEqual(omitted.recall,{module:'velaros:system',export:'memory',operation:'list',input:{kind:'history',after:0,through:records[15].sequence,limit:32}})
 const first=await history.list({after:0,limit:5},signal)
 await context.append({kind:'assistant',body:'concurrent new response'})
 const found=[...first.items];let cursor=first.nextAfter
 while(cursor!==null){const page=await history.list({after:cursor,through:first.through,limit:7},signal);found.push(...page.items);cursor=page.nextAfter}
 assert.deepEqual(found.map(item=>item.ref),records.map(item=>item.ref));assert(!JSON.stringify(found).includes('concurrent new response'))
 assert.equal((await context.read(found[1].ref)).text,'result 0')
 assert.equal((await history.list({limit:64},signal)).items.length,64)
 await assert.rejects(history.list({limit:65},signal),/范围/)
 await assert.rejects(history.list({after:-1},signal),/范围/)
 const aborted=AbortSignal.abort();await assert.rejects(history.list({},aborted),{name:'AbortError'})
})

test('INV-16 forty business rounds keep runtime context bounded while leases expire and original results survive',async t=>{
 const samples=[]; const started=Date.now();let durableRef
 const f=await fixture(t,async function*(request,f){
  const frame=runtimeFrame(request.materials[0].text)
  samples.push({round:f.calls,chars:request.materials[0].text.length,visible:frame.results.length,completedTurns:frame.programFrame.completedTurns})
  assert.equal(request.contextStatus.mode,'partitioned');assert(request.history.length<=9)
  assert(frame.results.length<=3,JSON.stringify(samples.at(-1)))
  assert.match(frame.observation.text,/persistent-observation/)
  if(f.calls>4){assert(!frame.results.some(item=>item.remainingTurns!=='task'&&item.text.includes('"iteration":1,')))}
  const durable=frame.results.find(item=>item.remainingTurns==='task')
  if(durable)durableRef=durable.ref
  if(f.calls===41){yield* done(request);return}
  const release=f.calls===16?`import {memory as memoryApi} from 'velaros:system';const {release}=memoryApi;await release({ref:${JSON.stringify(durableRef)}});`:''
  yield {type:'text',text:`${marker(request)} execute({retain:${f.calls===1?'"task"':2}})\n${release}import {output} from 'velaros';output({iteration:${f.calls},detail:'x'.repeat(12000)});\n${marker(request)}`}
  yield {type:'finish',reason:'stop'}
 },{limits:{turns:42,outputTokens:2048,safetyTokens:1024,projectionChars:24000,recoveryChars:6000,timeoutMs:90000}})
 await f.session.observe({source:"import {output} from 'velaros';output('persistent-observation');"})
 await run(f,'Run a long task with expiring results')
 assert.equal(f.calls,41)
 const state=await f.storage.load('s'); const leases=await f.programs.state()
 assert(leases.leases.length<=2);assert(!leases.leases.some(item=>item.task))
 assert.equal(state.records.filter(item=>item.kind==='assistant').length,41)
 assert.equal(state.records.filter(item=>/^script:[0-9a-f-]{36}:result$/.test(item.title)).length,81)
 assert((await f.programs.read(durableRef,0,60000)).text.includes('"iteration":1'))
 const steady=samples.slice(5); const maxChars=Math.max(...steady.map(item=>item.chars))
 assert(maxChars<40000,JSON.stringify(samples))
 assert(samples.at(-1).chars<=samples[5].chars+2000)
 t.diagnostic(JSON.stringify({modelCalls:f.calls,scriptRuns:81,records:state.records.length,elapsedMs:Date.now()-started,maxFrameChars:maxChars,finalFrameChars:samples.at(-1).chars,retainedLeases:leases.leases.length}))
})
