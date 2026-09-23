import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createContextRuntime} from '@velaros-ai/context'
import {localContextStorage} from '@velaros-ai/context/node'
import {nodeSubprocessCodeRunner} from '@velaros-ai/script'

import {BudgetedModelDriver} from '../../../dist/act/runtime/impl/BudgetedModelDriver.js'
import {ModelToolRuntime} from '../../../dist/act/runtime/impl/ModelToolRuntime.js'
import {createRuntime} from '../../../dist/act/runtime/index.js'

import {done,marker,runtimeFrame,turn} from './support/model-turn.mjs'

const model=stream=>({id:'model-tool-fixture',limits:{contextTokens:100000,inputTokens:90000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'exact',basis:'fixture'}),stream})
const execute=(request,source)=>turn(request,{execute:{source}})
const finish={type:'finish',reason:'stop'}
const delegate="import {start,wait} from 'velaros:agents';import {output} from 'velaros';const child=await start({task:'investigate',profile:'read'});output(await wait({id:child.id}));"

async function fixture(t,options){
 const storage=localContextStorage({path:':memory:'})
 const runtime=await createRuntime({storage,runner:nodeSubprocessCodeRunner,modules:[],...options})
 t.after(()=>runtime.close())
 return {runtime,storage,session:await runtime.openSession('root')}
}

const searchProfile={modelCalls:8,modelTokens:200000,finalizationTokens:16000,timeoutMs:30000,callTimeoutMs:3000,finalizationMs:4000,outputTokens:1024,projectionChars:32000,sourceQueries:16,candidates:64,reads:16,readBytes:128000}
const lookup="import {search} from 'velaros:search';import {output} from 'velaros';output(await search({query:'investigate'}));"
const searchOptions=stream=>({model:model(stream),defaultProfile:'standard',profiles:{standard:searchProfile}})
async function* report(request){const value=execute(request,"import {output} from 'velaros';import {report} from 'velaros:evidence';await report({findings:[],gaps:[],nextSteps:[]});");yield {...value,text:`${value.text}\n${marker(request)} done`};yield finish}

test('main, business child and search progress with one model slot and charge every ancestor exactly once',async t=>{
 let main=0; let childCalls=0; let searchCalls=0
 const child=model(async function*(request){
  if(++childCalls===1){yield execute(request,lookup);yield finish}
  else{yield {type:'usage',inputTokens:13,outputTokens:7};yield* done(request,'branch result')}
 })
 const f=await fixture(t,{modelTools:{concurrency:1},search:searchOptions(async function*(request){searchCalls++;yield {type:'usage',inputTokens:5,outputTokens:3};yield* report(request)}),agents:{concurrency:1,maxChildren:3,profiles:{read:{model:child,modules:['velaros:search']}}},model:model(async function*(request){if(++main===1){yield execute(request,delegate);yield finish}else yield* done(request)})})
 const events=[];for await(const event of f.session.submit('delegated investigation'))events.push(event)
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events))
 assert.equal(main,2);assert.equal(childCalls,2);assert.equal(searchCalls,1)
 const root=await f.session.view.inspect()
 assert.equal(root.usage.contextCalls,3)
 assert.equal(root.usage.inputTokens,18);assert.equal(root.usage.outputTokens,10)
 const snapshot=await f.storage.load('root')
 const bindings=[...new Map(snapshot.records.filter(record=>record.title.startsWith('model-tool:node:')).map(record=>[record.title,record])).values()]
 const values=await Promise.all(bindings.map(async record=>JSON.parse(await f.storage.get('root',record.objectId))))
 assert.deepEqual(values.map(value=>value.depth).sort(),[1,2]);assert(values.every(value=>value.status==='closed'))
 const deliveries=await Promise.all(snapshot.records.filter(record=>record.title==='model-tool:delivery').map(async record=>JSON.parse(await f.storage.get('root',record.objectId))))
 const delivery=deliveries.find(item=>item.kind==='agent');assert(delivery);assert.equal(delivery.parentTaskId,root.id)
 assert.equal(delivery.continuation.operation,'agents.resume');assert.equal(delivery.status,'completed')
 assert(delivery.artifacts.some(item=>item.kind==='script'));assert(delivery.artifacts.every(item=>item.ref.sessionId==='root'))
})

test('search inside a business child cannot escape the root ledger',async t=>{
 let main=0; let childCalls=0; let searchCalls=0
 const child=model(async function*(request){childCalls++;yield execute(request,lookup);yield finish})
 const f=await fixture(t,{context:{sources:[],limits:{modelCalls:2}},search:searchOptions(async function*(request){searchCalls++;yield* report(request)}),agents:{concurrency:1,maxChildren:3,profiles:{read:{model:child,modules:['velaros:search']}}},model:model(async function*(request){main++;yield execute(request,delegate);yield finish})})
 const events=[];for await(const event of f.session.submit('bounded investigation'))events.push(event)
 assert.equal(childCalls,1);assert.equal(main,1);assert.equal(searchCalls,0)
 assert.equal((await f.session.view.inspect()).usage.contextCalls,1)
 assert.equal(events.at(-1).status,'failed')
 assert.match(events.findLast(event=>event.type==='error').message,/预算/)
})

test('a stricter host depth cap omits child search from executable declarations',async t=>{
 let main=0; let calls=0; let searchCalls=0
 const child=model(async function*(request){if(++calls===1){yield execute(request,lookup);yield finish}else{assert.match(JSON.stringify(request),/Cannot find module 'velaros:search'/);yield* done(request)}})
 const f=await fixture(t,{modelTools:{maxDepth:1,concurrency:1},search:searchOptions(async function*(request){searchCalls++;yield* report(request)}),agents:{concurrency:1,maxChildren:3,profiles:{read:{model:child,modules:['velaros:search']}}},model:model(async function*(request){if(++main===1){yield execute(request,delegate);yield finish}else yield* done(request)})})
 const events=[];for await(const event of f.session.submit('depth'))events.push(event)
 assert.equal(searchCalls,0);assert.equal(calls,2);assert.equal(events.at(-1).status,'completed',JSON.stringify(events))
})

test('business child discovery and script declarations omit delegation even if the host profile lists it',async t=>{
 let main=0; let calls=0
 const child=model(async function*(request){
  if(++calls===1){yield execute(request,"import {modules} from 'velaros:system';import {output} from 'velaros';output(await modules.list({limit:64}));");yield finish}
  else if(calls===2){
   const frame=runtimeFrame(request.materials[0].text)
   const result=frame.results.map(item=>{try{return JSON.parse(item.text).result?.value?.default}catch{return null}}).find(value=>Array.isArray(value?.items))
   assert(result);assert(!result.items.some(item=>item.specifier==='velaros:agents'))
   yield execute(request,delegate);yield finish
  }else{assert.match(JSON.stringify(request),/velaros:agents/);yield* done(request)}
 })
 const f=await fixture(t,{agents:{concurrency:1,maxChildren:3,profiles:{read:{model:child,modules:['velaros:agents']}}},model:model(async function*(request){if(++main===1){yield execute(request,delegate);yield finish}else yield* done(request)})})
 const events=[];for await(const event of f.session.submit('check visibility'))events.push(event)
 assert.equal(calls,3);assert.equal(events.at(-1).status,'completed',JSON.stringify(events))
 const snapshot=await f.storage.load('root')
 assert.equal(new Set(snapshot.records.filter(record=>record.title.startsWith('model-tool:node:')).map(record=>record.title)).size,1)
})

async function coordinatorFixture(t,policy){
 const storage=localContextStorage({path:':memory:'});t.after(()=>storage.close())
 await createContextRuntime({sessionId:'root',storage}).append({kind:'user',body:'root task'})
 const accounts=new Map()
 const view=id=>{
  if(!accounts.has(id))accounts.set(id,{calls:0,tokens:0,input:0,output:0})
  const value=accounts.get(id)
  return {reserveModel:async(_role,tokens)=>{value.calls++;value.tokens+=tokens},releaseModel:async(_role,tokens)=>{value.calls--;value.tokens-=tokens},recordUsage:async(input,output)=>{value.input+=input;value.output+=output}}
 }
 const options={storage,policy,view,deadline:()=>undefined}
 const tools=new ModelToolRuntime(options);tools.root('root')
 return {storage,accounts,tools,options,signal:new AbortController().signal}
}

test('durable model-tool quotas survive coordinator replacement; resume retains ownership',async t=>{
 const f=await coordinatorFixture(t,{maxChildren:1,maxSessions:1})
 const first=await f.tools.begin('tool:a','root','search',10000,f.signal)
 await assert.rejects(f.tools.begin('tool:a','root','search',10000,f.signal),{code:'MODEL_TOOL_BUSY'})
 await first.close()
 const next=new ModelToolRuntime(f.options);next.root('root')
 await assert.rejects(next.begin('tool:b','root','search',10000,f.signal),{code:'MODEL_TOOL_QUOTA'})
 await assert.rejects(next.begin('tool:a','root','agent',10000,f.signal),{code:'MODEL_TOOL_SCOPE'})
 const resumed=await next.begin('tool:a','root','search',10000,f.signal);await resumed.close()
})

test('maintenance retains a leaf slot after business quota exhaustion and cannot recurse',async t=>{
 const f=await coordinatorFixture(t,{maxDepth:2,maxChildren:1,maxSessions:1})
 const business=await f.tools.begin('tool:a','root','agent',10000,f.signal)
 const maintenance=await f.tools.begin('context:tool:a','tool:a','context',10000,f.signal)
 await assert.rejects(f.tools.begin('tool:bad','context:tool:a','search',10000,f.signal),{code:'MODEL_TOOL_LEAF'})
 await maintenance.close();await business.close()
})

test('search is a leaf even when an internal caller attempts to open another model tool',async t=>{
 const f=await coordinatorFixture(t)
 const search=await f.tools.begin('search:a','root','search',10000,f.signal)
 for(const kind of ['agent','search','context'])await assert.rejects(f.tools.begin(`child:${kind}`,'search:a',kind,10000,f.signal),{code:'MODEL_TOOL_LEAF'})
 await search.close()
})

test('ancestor reservation failure refunds earlier accounts without refunding dispatched calls',async t=>{
 const f=await coordinatorFixture(t)
 const parent=await f.tools.begin('tool:a','root','agent',10000,f.signal)
 const view=f.options.view
 f.options.view=id=>id==='tool:a'?{...view(id),reserveModel:async()=>{throw Error('local budget exhausted')}}:view(id)
 const child=await f.tools.begin('tool:b','tool:a','search',10000,f.signal)
 await assert.rejects(child.budget.reserveModel('context',1000),/local budget/)
 assert.equal(f.accounts.get('root').calls,0);assert.equal(f.accounts.get('root').tokens,0)
 await child.close();await parent.close()
})

test('cancelling a queued model call prevents dispatch and leaves the slot usable',async t=>{
 const f=await coordinatorFixture(t,{concurrency:1})
 const release=Promise.withResolvers(); const entered=Promise.withResolvers();let calls=0
 const driver=f.tools.model('root',model(async function*(){calls++;entered.resolve();await release.promise;yield finish}))
 const first=(async()=>{for await(const event of driver.stream({},f.signal)){assert.equal(typeof event.type,"string")} })()
 await entered.promise
 const controller=new AbortController()
 const queued=(async()=>{for await(const event of driver.stream({},controller.signal)){assert.equal(typeof event.type,"string")} })()
 controller.abort();await assert.rejects(queued,{name:'AbortError'})
 release.resolve();await first
 for await(const event of driver.stream({},f.signal)){assert.equal(typeof event.type,"string")}
 assert.equal(calls,2)
})

test('a child cancelled in the model queue never reserves an ancestor call',async t=>{
 const f=await coordinatorFixture(t,{concurrency:1})
 const release=Promise.withResolvers(); const entered=Promise.withResolvers()
 const blocker=f.tools.model('root',model(async function*(){entered.resolve();await release.promise;yield finish}))
 const running=(async()=>{for await(const event of blocker.stream({},f.signal)){assert.equal(typeof event.type,"string")} })()
 await entered.promise
 const controller=new AbortController()
 const scope=await f.tools.begin('agent:queued','root','agent',10000,controller.signal)
 let dispatched=0
 const budgeted=new BudgetedModelDriver({model:model(async function*(){dispatched++;yield finish}),parent:scope.budget,signal:scope.signal})
 const driver=f.tools.model('agent:queued',budgeted)
 const queued=(async()=>{for await(const event of driver.stream({outputTokens:1000},controller.signal)){assert.equal(typeof event.type,"string")} })()
 controller.abort();await assert.rejects(queued,{name:'AbortError'})
 assert.equal(dispatched,0);assert.equal(f.accounts.get('root').calls,0)
 await budgeted.close();await scope.close();release.resolve();await running
})

test('the coordinator rejects agent-to-agent delegation independently of module grants',async t=>{
 const f=await coordinatorFixture(t)
 const parent=await f.tools.begin('agent:a','root','agent',10000,f.signal)
 await assert.rejects(f.tools.begin('agent:b','agent:a','agent',10000,f.signal),{code:'MODEL_TOOL_DELEGATION'})
 await parent.close()
})

test('main defaults are large task ceilings while explicit host budgets remain authoritative',async t=>{
 const f=await fixture(t,{model:model(async function*(request){yield* done(request)})})
 assert.equal(f.session.view.limits.modelCalls,100000);assert.equal(f.session.view.limits.modelTokens,100000000)
 const limited=await fixture(t,{context:{sources:[],limits:{modelCalls:7,modelTokens:10000}}})
 assert.equal(limited.session.view.limits.modelCalls,7);assert.equal(limited.session.view.limits.modelTokens,10000)
})

test('search only discovers its evidence and local system members, including in the aggregate template',async t=>{
 let main=0; let calls=0; let checked=false
 const search=searchOptions(async function*(request){
  calls++
  if(calls===1){yield execute(request,"import {modules} from 'velaros:system';import {output} from 'velaros';output({catalog:await modules.list({limit:64}),system:await modules.describe({module:'velaros:system'})});");yield finish}
  else{
   const text=JSON.stringify(request)
   assert(!text.includes('memory.organize'));assert(!text.includes('context.request'));assert(!text.includes('velaros:agents'));assert(!text.includes('velaros:context-materials'));assert(!text.includes('velaros:search'))
   assert(text.includes('velaros:evidence'));checked=true
   yield* report(request)
  }
 })
 const f=await fixture(t,{search,model:model(async function*(request){if(++main===1){yield execute(request,lookup);yield finish}else yield* done(request)})})
 const events=[];for await(const event of f.session.submit('find evidence'))events.push(event)
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events));assert.equal(calls,2);assert(checked)
})

test('new logical task renews child allocation; continuing cannot reset the task quota',async t=>{
 let main=0; let children=0
 const f=await fixture(t,{agents:{concurrency:1,maxChildren:1,profiles:{read:{modules:[],model:model(async function*(request){children++;yield* done(request)})}}},model:model(async function*(request){if(++main%2){yield execute(request,delegate);yield finish}else yield* done(request)})})
 for(const input of ['First task',{text:'Continue',task:'continue'},{text:'New task',task:'new'}]){const events=[];for await(const event of f.session.submit(input))events.push(event);assert.equal(events.at(-1).status,'completed',JSON.stringify(events))}
 assert.equal(children,2);assert.equal(main,6)
})
