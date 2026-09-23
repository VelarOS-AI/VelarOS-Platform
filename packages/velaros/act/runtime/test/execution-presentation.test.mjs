import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createContextRuntime} from '@velaros-ai/context'
import {localContextStorage} from '@velaros-ai/context/node'

import {RuntimeTrace} from '../../../dist/act/runtime/impl/RuntimeTrace.js'
import {summarizeInvocation} from '../../../dist/act/runtime/utils/tracePresentation.js'

const prepared={id:'call',sessionId:'s',executionId:'execution',binding:{moduleId:'velaros:project',instanceId:'root'},operation:'edit',input:{path:'hello.txt'},inputFingerprint:'input',requestFingerprint:'request'}
test('INV-45 invocation presentation distinguishes receipts, cancellation and unknown effects',()=>{
 for(const status of ['pending','succeeded','failed','cancelled']){
  const record={phase:status==='pending'?'prepared':'settled',prepared,...(status==='pending'?{}:{receipt:{invocation:prepared,outcome:status,effect:'partial',retry:'requires-check',value:{ok:true},...(status==='failed'?{error:{code:'WRITE',message:'write failed'}}:{})}})}
  const view=summarizeInvocation(record,8000)
  assert.equal(view.status,status)
  assert.equal(view.effect,status==='pending'?'unknown':'partial')
  assert.equal(view.input,JSON.stringify(prepared.input))
  assert.equal(view.outputTruncated,false)
  if(status==='failed')assert.match(view.output,/write failed/)
  if(status==='pending')assert.equal(view.output,'')
 }
 const reconciled=summarizeInvocation({phase:'prepared',prepared,reconciliation:{outcome:'succeeded',effect:'committed',evidence:'checked',checkedAt:'now'}},8000)
 assert.equal(reconciled.status,'pending','reconciliation must not rewrite the original receipt')
})
test('presentation keeps typed identity even when JSON previews are truncated',()=>{
 const record={phase:'settled',prepared:{...prepared,input:'x'.repeat(10000)},receipt:{outcome:'succeeded',effect:'committed',value:'y'.repeat(10000)}}
 const view=summarizeInvocation(record,11)
 assert.equal(view.input.length+view.output.length,11)
 assert.equal(view.inputTruncated,true);assert.equal(view.outputTruncated,true)
 assert.equal(view.moduleId,'velaros:project');assert.equal(view.status,'succeeded')
 const empty=summarizeInvocation(record,0)
 assert.equal(empty.input,'');assert.equal(empty.output,'');assert.equal(empty.status,'succeeded')
})
test('trace and paginated trace share the total body budget including execution previews',async t=>{
 const storage=localContextStorage({path:':memory:'});t.after(()=>storage.close())
 const context=createContextRuntime({sessionId:'s',storage}); const executionId=crypto.randomUUID()
 const source=await context.append({kind:'audit',title:'source',body:'source'})
 const result=await context.append({kind:'audit',title:`script:${executionId}:result`,body:'{}',sources:[source.ref]})
 for(let turn=0;turn<2;turn++){
  const request=await context.append({kind:'audit',title:'model-request',body:JSON.stringify({runId:'run',turn,repair:0,request:{materials:[{origin:'runtime-view',text:JSON.stringify({partitions:{task:{goals:[]},observation:{sourceRef:source.ref.id,resultRef:result.ref.id},recent:{results:[]}}})}]}})})
  const response=await context.append({kind:'assistant',body:'done',sources:[request.ref]})
  await context.append({kind:'audit',title:'model-response',body:JSON.stringify({rawRef:response.ref,status:'accepted',decoded:{done:true}}),sources:[request.ref]})
 }
 const call={...prepared,executionId,input:'a'.repeat(10000)}
 const journal={list:async()=>[{phase:'settled',prepared:call,receipt:{outcome:'succeeded',effect:'committed',value:'b'.repeat(10000)}}]}
 const trace=new RuntimeTrace('s',storage,journal)
 const page=await trace.page({maxChars:1500})
 const total=page.turns.reduce((sum,turn)=>sum+[turn.request,turn.response,turn.decision,...turn.records,...turn.invocations].reduce((n,record)=>n+(record?.body?.length??0),0)+turn.invocations.reduce((n,record)=>n+record.summary.input.length+record.summary.output.length,0),0)
 assert(total<=1500)
 assert.equal(page.turns[0].invocations[0].summary.status,'succeeded')
 assert.equal(page.turns[0].invocations[0].summary.outputTruncated,true)
 assert.equal(page.turns[0].invocations[0].id,'call')
})
