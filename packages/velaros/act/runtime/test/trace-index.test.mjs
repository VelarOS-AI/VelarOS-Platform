import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createContextRuntime} from '@velaros-ai/context'
import {localContextStorage} from '@velaros-ai/context/node'

import {RuntimeTrace} from '../../../dist/act/runtime/impl/RuntimeTrace.js'

test('trace pages use one metadata snapshot and query only associated execution journals',async t=>{
 const storage=localContextStorage({path:':memory:'});t.after(()=>storage.close())
 const context=createContextRuntime({sessionId:'s',storage}); const executionId=crypto.randomUUID()
 const source=await context.append({kind:'audit',title:'source',body:'source'})
 const result=await context.append({kind:'audit',title:`script:${executionId}:result`,body:'{}',sources:[source.ref]})
 const requests=[]
 for(let turn=0;turn<3;turn++){
  const request=await context.append({kind:'audit',title:'model-request',body:JSON.stringify({runId:'run',turn,repair:0,request:{materials:[{origin:'runtime-view',text:JSON.stringify({partitions:{task:{goals:[]},observation:{sourceRef:source.ref.id,resultRef:result.ref.id},recent:{results:[]}}})}]}})})
  requests.push(request)
  const response=await context.append({kind:'assistant',body:'done',sources:[request.ref]})
  await context.append({kind:'audit',title:'model-response',body:JSON.stringify({rawRef:response.ref,status:'accepted',decoded:{done:true}}),sources:[request.ref]})
 }
 let loads=0;const lookups=[]
 const port={load:async id=>{loads++;return storage.load(id)},get:(...args)=>storage.get(...args)}
 const journal={list:async(sessionId,id)=>{assert.equal(sessionId,'s');assert.equal(id,executionId);lookups.push(id);return []}}
 const page=await new RuntimeTrace('s',port,journal).page({limit:3})
 assert.equal(loads,1);assert.equal(page.turns.length,3);assert.equal(lookups.length,3)
 assert(page.turns.every(turn=>turn.snapshotVersion===page.snapshotVersion))
 assert(page.turns.every(turn=>turn.records.some(record=>record.ref.id===source.ref.id)))
 assert(page.turns.every(turn=>Object.values(turn.timing).every(value=>value===null)))
 assert.equal(page.nextAfter,null)
 assert.equal(page.turns[0].nextTurnId,requests[1].ref.id)
})
