import assert from 'node:assert/strict'
import {test} from 'node:test'

import {localContextStorage} from '@velaros-ai/context/node'
import {nodeSubprocessCodeRunner} from '@velaros-ai/script'

import {ContextMemory} from '../../../dist/act/runtime/impl/ContextMemory.js'
import {ProgramContext} from '../../../dist/act/runtime/impl/ProgramContext.js'
import {RecentContext} from '../../../dist/act/runtime/impl/RecentContext.js'
import {createRuntime} from '../../../dist/act/runtime/index.js'
import {ContextMaintenanceState} from '../../../dist/act/system/impl/ContextMaintenanceState.js'

import {done,marker,turn} from './support/model-turn.mjs'

const signal=new AbortController().signal
async function fixture(t,source,modelOverride){
 const storage=localContextStorage({path:':memory:'});const requests=[];let reads=0;let value=1
 const model=modelOverride??{id:'output-context',limits:{contextTokens:100000,inputTokens:90000,outputTokens:4000},estimate:async()=>({tokens:1000,precision:'exact',basis:'test'}),async *stream(request){requests.push(request);yield* done(request)}}
 const runtime=await createRuntime({storage,runner:nodeSubprocessCodeRunner,model,modules:[{binding:{moduleId:'test:world',instanceId:'world',generation:1,schemaRevision:'1'},summary:'counter',operations:{read:{summary:'read current value',input:{type:'null'},output:{type:'integer'},effects:'none',run:()=>{reads++;return value}}}}]})
 t.after(()=>runtime.close());const session=await runtime.openSession('root');await session.context.append({kind:'user',body:'Observe current state'})
 const initial=await session.observe({source})
 const programs=new ProgramContext('root',session.context,storage);const maintenance=new ContextMaintenanceState('root',storage)
 async function run(){const events=[];for await(const e of session.submit('Continue observing'))events.push(e);assert.equal(events.at(-1).status,'completed',JSON.stringify(events))}
 async function project(ref){const view=(await session.view.inspect()).view;return JSON.parse((await programs.project(view,{sessionId:'root',id:ref},[],signal,16000)).body)}
 const memory=new ContextMemory('root',session.context,storage,session.view,programs,new RecentContext('root',session.context,storage))
 return {note:()=>memory.update({key:'primary',baseRevision:0,body:'Primary original'},signal),storage,session,programs,maintenance,initial,requests,run,project,get reads(){return reads},set value(v){value=v}}
}
const source=`import {output} from 'velaros';import {read} from 'test:world';
output.configure({maxChars:14000});
const state=await read();
output({state},{key:'state',purpose:'watch current state',priority:'high',view:{maxChars:2000}});
output(Array.from({length:40},(_,i)=>({i,text:'e'.repeat(100)})),{key:'logs',type:'list',view:{maxItems:20,edge:'tail',maxChars:6000}});`
const patch=(snapshot,observation)=>({baseRevision:snapshot.baseRevision,summary:'Reduce logs while preserving current state',unresolved:[],observation})

test('INV-22 emergency source edit rerenders archived observation without another read, and next normal round refreshes',async t=>{
 const f=await fixture(t,source);await f.run();assert.equal(f.reads,1)
 const snap=await f.maintenance.snapshot(10000,signal)
 const ref=snap.observation.resultRef
 await f.maintenance.apply(snap,patch(snap,{sourceRef:snap.observationRef,config:{maxChars:3000},outputs:[{key:'logs',view:{maxItems:2,edge:'tail',maxChars:800}}]}),signal)
 assert.equal(f.reads,1)
 const frame=await f.project(ref)
 assert.notEqual(frame.observation.sourceRef,f.initial.sourceRef)
 assert.equal(frame.observation.collectedSourceRef,f.initial.sourceRef)
 assert.equal(frame.observation.resultRef,ref)
 assert.equal(frame.observation.adjustment.executed,false)
 assert.equal(frame.observation.presentation.requestedChars,3000)
 assert.match(frame.observation.source,/"maxItems":2/)
 const blocks=JSON.parse(frame.observation.text).blocks
 assert.deepEqual(JSON.parse(blocks.find(b=>b.key==='logs').text).map(x=>x.i),[38,39])
 f.value=2;await f.run();assert.equal(f.reads,2)
 const next=JSON.parse(f.requests.at(-1).materials[0].text).partitions.observation
 assert.equal(next.collectedSourceRef,next.presentationSourceRef)
 assert.equal(JSON.parse(JSON.parse(next.text).blocks.find(b=>b.key==='state').text).state,2)
})

test('INV-23 late invalid metadata keeps source and all other changes unpublished',async t=>{
 const f=await fixture(t,source);await f.run();const note=await f.note();const snap=await f.maintenance.snapshot(10000,signal)
 await assert.rejects(f.maintenance.apply(snap,{...patch(snap,{sourceRef:snap.observationRef,outputs:[{key:'missing',view:{maxChars:20}}]}),notes:[{ref:note.ref,summary:'must not be visible'}]},signal),/不存在/)
 assert.equal((await f.programs.state()).observation,f.initial.sourceRef)
 assert(!(await f.storage.load('root')).records.some(r=>r.title==='context:projection-policy'))
 assert.equal(f.reads,1)
})

test('summary binds original content and user goal generation; stale or forged summaries cannot pass',async t=>{
 const f=await fixture(t,source);await f.run();const snap=await f.maintenance.snapshot(10000,signal)
 const state=snap.observation.blocks.find(b=>b.key==='state')
 const summary={key:'state',resultRef:snap.observation.resultRef,contentHash:state.contentHash,text:'Current state is one.'}
 await assert.rejects(f.maintenance.apply(snap,patch(snap,{sourceRef:snap.observationRef,summaries:[{...summary,contentHash:'forged'}]}),signal),/不匹配/)
 await f.maintenance.apply(snap,patch(snap,{sourceRef:snap.observationRef,outputs:[{key:'state',view:{mode:'summary'}}],summaries:[summary]}),signal)
 const rendered=await f.project(snap.observation.resultRef)
 assert.equal(JSON.parse(rendered.observation.text).blocks.find(b=>b.key==='state').representation,'summary')
 f.value=2;await f.run()
 const next=JSON.parse(f.requests.at(-1).materials[0].text).partitions.observation
 assert.equal(JSON.parse(next.text).blocks.find(b=>b.key==='state').reason,'summary-unavailable')
})

test('failure preserves completed blocks and reports missing outputs separately from empty successful values',async t=>{
 const f=await fixture(t,`import {output} from 'velaros';output([],{key:'empty',type:'list'});throw Error('read unavailable');output(3,{key:'later'});`)
 await f.run();const view=JSON.parse(f.requests[0].materials[0].text).partitions.observation
 assert.equal(view.collection,'partial');assert.match(view.failure.message,/read unavailable/)
 assert.deepEqual(view.missingOutputs,[{key:'later',status:'not-produced'}])
 assert.equal(JSON.parse(view.text).blocks[0].text,'[]')
})

test('duplicate managed keys surface a repairable observation failure rather than breaking context assembly',async t=>{
 const f=await fixture(t,`import {output} from 'velaros';output(1,{key:'x'});try{output(2,{key:'x'})}catch{}`)
 await f.run();const view=JSON.parse(f.requests[0].materials[0].text).partitions.observation
 assert.equal(view.collection,'partial');assert.match(view.collectionIssues.join(),/重复/)
})

test('large once-only output remains fully recallable while its declared view stays bounded',async t=>{
 const f=await fixture(t,source)
 const result=await f.session.execute({source:`import {output} from 'velaros';output({large:'x'.repeat(90000),state:7},{key:'large',type:'json',view:{paths:['/state'],maxChars:1000}});`})
 assert.equal(result.checked,true);assert.equal(result.result.failed,undefined)
 await f.run();const frame=JSON.parse(f.requests[0].materials[0].text)
 const raw=await f.programs.read(result.resultRef,0,1)
 const record=JSON.parse(await f.storage.get('root',raw.record.objectId))
 assert.equal(record.output.blocks[0].value.large.length,90000)
 assert(!f.requests[0].compiledPrompt.includes('x'.repeat(5000)))
 assert.equal(frame.partitions.recent.results[0].remainingTurns,2)
})

test('native image is delivered, and emergency reference policy detaches it without another observation',async t=>{
 const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWAAAAABJRU5ErkJggg=='
 const f=await fixture(t,`import {output} from 'velaros';output({type:'image-data',mediaType:'image/png',data:${JSON.stringify(data)},label:'pixel'},{key:'image',type:'image'});`)
 await f.run();assert.equal(f.requests[0].images.length,1);assert(!JSON.parse(f.requests[0].materials[0].text).partitions.observation.text.includes(data))
 const snap=await f.maintenance.snapshot(12000,signal)
 await f.maintenance.apply(snap,patch(snap,{sourceRef:snap.observationRef,outputs:[{key:'image',view:{mode:'reference'}}]}),signal)
 const raw=await f.session.context.read({sessionId:'root',id:snap.observation.resultRef},{limit:60000})
 const saved=JSON.parse(raw.text)
 const imageRecord=await f.session.context.read(saved.attachments[0],{limit:60000})
 const frame=await f.programs.project((await f.session.view.inspect()).view,{sessionId:'root',id:snap.observation.resultRef},[JSON.parse(imageRecord.text)],signal,16000)
 assert.equal(frame.images.length,0)
 const body=JSON.parse(frame.body)
 assert.equal(body.observation.nativeImages[0].attached,false)
 assert.equal(body.observation.presentationChanges[0].key,'image')
})

test('source or user changes invalidate an in-flight output patch',async t=>{
 const f=await fixture(t,source);await f.run();const snap=await f.maintenance.snapshot(10000,signal)
 await f.session.observe({source:source.replace('maxItems:20','maxItems:10')})
 await assert.rejects(f.maintenance.apply(snap,patch(snap,{sourceRef:snap.observationRef,config:{maxChars:2000}}),signal),{code:'CONTEXT_CONFLICT'})
 const next=await f.maintenance.snapshot(10000,signal)
 await f.session.context.append({kind:'user',body:'Keep all error details'})
 await assert.rejects(f.maintenance.apply(next,patch(next,{sourceRef:next.observationRef,config:{maxChars:1000}}),signal),{code:'CONTEXT_CONFLICT'})
})

test('the actual independent maintenance tool publishes output policy before the next main request without observer replay',async t=>{
 let reads=0; let toolCalls=0; let mainCalls=0
 const limits={contextTokens:100000,inputTokens:90000,outputTokens:8192}
 const estimate=async()=>({tokens:1000,precision:'exact',basis:'test'})
 const main={id:'main',limits,estimate,async *stream(request){mainCalls++;const frame=JSON.parse(request.materials[0].text);const observation=frame.partitions.observation;assert.equal(observation.presentation.requestedChars,1500);if(mainCalls===1)assert.notEqual(observation.collectedSourceRef,observation.presentationSourceRef);else{assert.equal(observation.collectedSourceRef,observation.presentationSourceRef);assert.equal(frame.partitions.runtime.progress.script.changed,false)}yield* done(request)}}
 const maintenance={id:'maintenance',limits,estimate,async *stream(request){
  toolCalls++;const snap=JSON.parse(JSON.parse(request.materials[0].text).partitions.task.goals[0].text).snapshot
  const proposed=patch(snap,{sourceRef:snap.observationRef,config:{maxChars:1500},outputs:[{key:'state',view:{maxChars:500}}]})
  const response=turn(request,{execute:{source:`import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify(proposed)}));`}})
  yield {...response,text:`${response.text}\n${marker(request)} done`};yield {type:'finish',reason:'stop'}
 }}
 const storage=localContextStorage({path:':memory:'})
 const runtime=await createRuntime({storage,runner:nodeSubprocessCodeRunner,model:main,context:{sources:[],maintenance:{model:maintenance}},modules:[{binding:{moduleId:'test:world',instanceId:'world',generation:1,schemaRevision:'1'},summary:'counter',operations:{read:{summary:'read',input:{type:'null'},output:{type:'integer'},effects:'none',run:()=>{reads++;return 1}}}}]})
 t.after(()=>runtime.close());const session=await runtime.openSession('root');await session.context.append({kind:'user',body:'work'})
 await session.observe({source:`import {output} from 'velaros';import {read} from 'test:world';output(await read(),{key:'state',view:{maxChars:2000}});`})
 const scheduled=await session.execute({source:`import {memory as context} from 'velaros:system';await context.organize({focus:'next investigate'});`})
 assert(!scheduled.result.failed)
 const events=[];for await(const event of session.submit('Observe the current value'))events.push(event)
 assert.equal(events.at(-1).status,'completed',JSON.stringify(events))
 assert.deepEqual({reads,toolCalls,mainCalls},{reads:1,toolCalls:1,mainCalls:1})
 t.diagnostic(JSON.stringify({observationReads:reads,maintenanceCalls:toolCalls,mainCalls,policyInSource:true,replayed:false}))
 for await(const event of session.submit('Check again')){assert.equal(typeof event.type,"string")}
 assert.deepEqual({reads,toolCalls,mainCalls},{reads:2,toolCalls:1,mainCalls:2})
})

test('a maintenance candidate cannot hide required content and all staged metadata stays unpublished',async t=>{
 const f=await fixture(t,`import {output} from 'velaros';output({value:1},{key:'critical',required:true});`)
 await f.run();const note=await f.note();const snap=await f.maintenance.snapshot(10000,signal)
 await assert.rejects(f.maintenance.apply(snap,{...patch(snap,{sourceRef:snap.observationRef,outputs:[{key:'critical',view:{mode:'reference'}}]}),notes:[{ref:note.ref,summary:'candidate'}]},signal),{code:'CONTEXT_REQUIRED'})
 assert.equal((await f.programs.state()).observation,snap.observationRef)
 assert(!(await f.storage.load('root')).records.some(r=>r.title==='context:projection-policy'))
})

test('the parent model budget validator rejects a fully staged candidate before CAS publication',async t=>{
 const f=await fixture(t,source);await f.run();let previews=0
 const state=new ContextMaintenanceState('root',f.storage,{validateCandidate:async candidate=>{previews++;assert.equal(JSON.parse(candidate.body).partitions.workspace.notes[0].text,'candidate');throw Object.assign(Error('input budget'),{code:'CONTEXT_BUDGET'})}})
 const note=await f.note();const snap=await state.snapshot(10000,signal)
 await assert.rejects(state.apply(snap,{...patch(snap),notes:[{ref:note.ref,summary:'candidate'}]},signal),{code:'CONTEXT_BUDGET'})
 assert.equal(previews,1);assert.equal(f.reads,1);assert(!(await f.storage.load('root')).records.some(r=>r.title==='context:projection-policy'))
})
