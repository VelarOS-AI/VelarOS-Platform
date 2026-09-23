
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {localContextStorage} from '@velaros-ai/context/node'
import {nodeSubprocessCodeRunner} from '@velaros-ai/script'

import {createRuntime} from '../../../dist/act/runtime/index.js'

import {modelText} from './support/model-turn.mjs'
import {runtimeFrame} from './support/model-turn.mjs'
import {done,marker,turn} from './support/model-turn.mjs'

const finish={type:'finish',reason:'stop'}
const block=(request,source)=>`${marker(request)} execute\n${source}\n${marker(request)}\n`
async function setup(t,stream,extra={}){
 const root=await mkdtemp(join(tmpdir(),'act-run-')); const path=join(root,'state.sqlite')
 const config={storage:localContextStorage({path}),runner:nodeSubprocessCodeRunner,modules:[],model:{id:'test',limits:{contextTokens:150000,inputTokens:140000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'exact',basis:'fixture'}),stream},...extra}
 const runtime=await createRuntime(config); const session=await runtime.openSession('main')
 t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true})})
 return {runtime,session,path,config}
}

test('steering archives user input and preempts an unaccepted response without executing its code',async t=>{
 let calls=0
 const f=await setup(t,async function*(request,signal){
  calls++
  if(calls===1){yield {type:'text',text:'正在处理旧方向。'};await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve()});yield {type:'text',text:block(request,"throw Error('stale response executed')")};yield finish}
  else{assert.match(modelText(request),/改为只调查/);yield* done(request)}
 })
 const events=[];let sent=false
 for await(const event of f.session.submit('调查并修改')){events.push(event);if(event.type==='text'&&!sent){sent=true;await f.session.steer('改为只调查，不修改')}}
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(calls,2)
 assert.equal((await f.session.view.inspect()).goals.length,2)
 const persisted=await f.session.events();assert(persisted.some(item=>item.event.type==='input'))
 assert(!persisted.some(item=>item.event.type==='state'&&item.event.status==='executing'))
})

test('script interaction is delivered while execution waits and answers bind to one request',async t=>{
 let calls=0
 const f=await setup(t,async function*(request){calls++;if(calls===1){yield {type:'text',text:block(request,"import {ask} from 'velaros:interaction';import {output} from 'velaros';output(await ask({message:'选择范围'}));")};yield finish}else{assert.match(modelText(request),/auth/);yield* done(request)}})
 let question
 const events=[]
 for await(const event of f.session.submit('查找入口')){
  events.push(event)
  if(event.type==='interaction'){
   question=event.request;assert.equal((await f.session.inspect()).status,'waiting')
   await assert.rejects(()=>f.session.answer({id:question.id,runId:'wrong',value:'bad'}))
   await f.session.answer({id:question.id,runId:question.runId,value:'auth'})
   await assert.rejects(()=>f.session.answer({id:question.id,runId:question.runId,value:'duplicate'}))
  }
 }
 assert(question);assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(calls,2)
 assert.equal((await f.session.inspect()).pending.length,0)
 const persisted=await f.session.events();assert(persisted.some(item=>item.event.type==='interaction'));assert(persisted.some(item=>item.event.type==='answer'))
 assert.deepEqual(await f.session.events(persisted.at(-1).sequence),[])
})

test('cancelling a pending interaction releases the run and rejects late answers',async t=>{
 const f=await setup(t,async function*(request){yield {type:'text',text:block(request,"import {ask} from 'velaros:interaction';await ask({message:'继续吗'});")};yield finish})
 let question;const events=[]
 for await(const event of f.session.submit('调查')){events.push(event);if(event.type==='interaction'){question=event.request;f.session.cancel()}}
 assert(question);assert.equal(events.at(-1).status,'cancelled',JSON.stringify(events))
 await assert.rejects(()=>f.session.answer({id:question.id,runId:question.runId,value:'late'}))
 assert.equal((await f.session.view.inspect()).lease,null)
})

test('run state and event cursor survive reopening the same storage',async t=>{
 const f=await setup(t,async function*(request){yield* done(request)})
 for await(const event of f.session.submit('读取')){assert.equal(typeof event.type,"string")}
 const before=await f.session.inspect(); const events=await f.session.events()
 await f.runtime.close()
 const runtime=await createRuntime({...f.config,storage:localContextStorage({path:f.path})})
 try{const session=await runtime.openSession('main');assert.deepEqual(await session.inspect(),before);assert.deepEqual(await session.events(),events)}finally{await runtime.close()}
})

test('trace connects actual compiled requests, edited observer, write receipts, leases and the next v2 frame',async t=>{
 let world='v1'; let writes=0; let calls=0;const sent=[]
 const module={binding:{moduleId:'test:trace',instanceId:'fixture',generation:1,schemaRevision:'1'},summary:'trace fixture',operations:{
  read:{summary:'read',input:{type:'null'},output:{type:'string'},effects:'none',run:()=>world},
  write:{summary:'write',input:{type:'string'},output:{type:'string'},effects:'write',run:(input,call)=>{writes++;world=input;call.recordEffect('committed');return world}},
 }}
 const source="import {read} from 'test:trace';import {output} from 'velaros';output({version:await read(),label:'before'});"
 const f=await setup(t,async function*(request){
  sent.push(structuredClone(request));calls++
  if(calls===1){yield turn(request,{observe:{edits:[{oldText:"label:'before'",newText:"label:'after'"}]},execute:{source:"import {write} from 'test:trace';import {output} from 'velaros';output(await write('v2'));",retainTurns:1}});yield finish}
  else yield* done(request,'verified v2')
 },{modules:[module]})
 await f.session.observe({source})
 const events=[];for await(const event of f.session.submit('Read v1, write v2 and verify'))events.push(event)
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(writes,1)
 const turns=events.filter(event=>event.type==='turn'); const first=await f.session.trace(turns[0].turnId); const second=await f.session.trace(turns[1].turnId)
 assert.deepEqual(JSON.parse(first.request.body).request,JSON.parse(JSON.stringify(sent[0])));assert.deepEqual(JSON.parse(second.request.body).request,JSON.parse(JSON.stringify(sent[1])))
 assert.deepEqual(first.gaps,[]);assert.equal(first.nextTurnId,second.turnId)
 assert.equal(JSON.parse(first.decision.body).status,'accepted');assert.match(first.response.body,/write\('v2'\)/)
 const operations=first.invocations.map(item=>JSON.parse(item.body))
 assert(operations.some(item=>item.prepared.operation==='write'&&item.receipt.effect==='committed'))
 assert(first.records.some(item=>item.title.startsWith('script:version:')))
 assert(first.records.some(item=>item.title==='script:lease-state'&&JSON.parse(item.body).leases.length))
 const nextFrame=runtimeFrame(JSON.parse(second.request.body).request.materials.at(-1).text)
 assert.match(nextFrame.observation.text,/v2/);assert.match(nextFrame.observation.text,/after/)
 assert.equal(nextFrame.results[0].remainingTurns,1)
 const bounded=await f.session.trace(turns[0].turnId,31)
 // 请求与调用的摘要和正文共用同一份预算（INV-45/46）：合计正好用满
 assert.equal([bounded.request,bounded.response,bounded.decision,...bounded.records,...bounded.invocations].reduce((n,item)=>n+(item?.body?.length??0),0)+bounded.requestSummary.system.length+bounded.requestSummary.messages.length+bounded.invocations.reduce((n,item)=>n+item.summary.input.length+item.summary.output.length,0),31)
 assert(bounded.request.truncated)
 const other=await f.runtime.openSession('other');await assert.rejects(other.trace(first.turnId),/当前会话/)
 await f.runtime.close()
 const runtime=await createRuntime({...f.config,storage:localContextStorage({path:f.path})})
 try{const session=await runtime.openSession('main');const restored=await session.trace(first.turnId);assert.equal(restored.response.body,first.response.body);assert.deepEqual(restored.invocations,first.invocations);assert.equal(writes,1)}finally{await runtime.close()}
})

test('rejected protocol and truncated provider responses retain raw text without dispatch',async t=>{
 let calls=0
 const f=await setup(t,async function*(request){
  calls++
  if(calls===1){yield {type:'text',text:`${marker(request)} execute\nimport {output} from 'velaros';output('unterminated');`};yield finish}
  else{yield {type:'text',text:'partial output'};yield {type:'finish',reason:'length'}}
 })
 const events=[];for await(const event of f.session.submit('work'))events.push(event)
 assert.equal(events.at(-1).status,'failed')
 const turns=events.filter(event=>event.type==='turn');assert.equal(turns.length,2)
 for(const event of turns){const trace=await f.session.trace(event.turnId);assert.equal(JSON.parse(trace.decision.body).status,'rejected');assert(trace.response.body.length);assert.equal(trace.invocations.length,0);assert(!trace.records.some(item=>item.title==='script:dispatch'))}
 assert.match((await f.session.trace(turns[0].turnId)).response.body,/unterminated/)
 assert.equal((await f.session.trace(turns[1].turnId)).response.body,'partial output')
})

test('runtime shutdown attempts kernel and storage cleanup even when a session cleanup fails',async t=>{
 let disposed=false
 const f=await setup(t,async function*(request){yield* done(request)},{modules:[{binding:{moduleId:'test:cleanup',instanceId:'fixture',generation:1,schemaRevision:'1'},summary:'cleanup fixture',operations:{},dispose(){disposed=true}}]})
 let closed=false;const close=f.config.storage.close.bind(f.config.storage)
 f.config.storage.close=async()=>{closed=true;await close()}
 f.session.close=async()=>{throw Error('session close fault')}
 await assert.rejects(f.runtime.close(),AggregateError);assert.equal(closed,true);assert.equal(disposed,true)
 assert.equal(f.runtime.getSession('main'),undefined)
 // The same rejected shutdown promise remains observable to callers.
 f.runtime.close=async()=>{}
})

test('two Runtime instances cannot run models concurrently for one durable session',async t=>{
 let calls=0
 const f=await setup(t,async function*(request,signal){calls++;yield {type:'text',text:'waiting'};await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve()});yield* done(request)})
 const otherRuntime=await createRuntime({...f.config,storage:localContextStorage({path:f.path})}); const other=await otherRuntime.openSession('main')
 let lease
 try{
  for await(const event of f.session.submit('owner'))if(event.type==='text'){
   lease=(await f.session.view.inspect()).lease.id
   const rejected=[];for await(const item of other.submit('contender'))rejected.push(item)
   assert.equal(rejected.at(-1).status,'failed');assert(rejected.some(item=>item.type==='error'&&item.message.includes('租约')))
   assert.equal((await other.view.inspect()).lease.id,lease);f.session.cancel()
  }
  assert.equal(calls,1);assert.equal((await f.session.view.inspect()).lease,null)
 }finally{await otherRuntime.close()}
})

test('a reopened host can inspect a durable pending interaction but cannot answer its previous process promise',async t=>{
 const f=await setup(t,async function*(request){yield {type:'text',text:block(request,"import {ask} from 'velaros:interaction';await ask({message:'confirm scope'});")};yield finish})
 const otherRuntime=await createRuntime({...f.config,storage:localContextStorage({path:f.path})})
 try{
  const events=[]
  for await(const event of f.session.submit('work')){
   events.push(event)
   if(event.type==='interaction'){
    const restored=await otherRuntime.openSession('main'); const snapshot=await restored.inspect()
    assert.equal(snapshot.status,'interrupted');assert.deepEqual(snapshot.pending,[])
    const history=await restored.events();assert(history.some(item=>item.event.type==='interaction'&&item.event.request.id===event.request.id))
    await assert.rejects(restored.answer({id:event.request.id,runId:event.runId,value:'late'}),/过期|当前运行/)
    f.session.cancel()
   }
  }
  assert.equal(events.at(-1).status,'cancelled');assert.equal((await f.session.view.inspect()).lease,null)
 }finally{await otherRuntime.close()}
})
