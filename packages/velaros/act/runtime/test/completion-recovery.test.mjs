import assert from 'node:assert/strict'
import {test} from 'node:test'

import {localContextStorage} from '@velaros-ai/context/node'
import {nodeSubprocessCodeRunner} from '@velaros-ai/script'

import {createRuntime} from '../../../dist/act/runtime/index.js'

import {done,turn} from './support/model-turn.mjs'
async function setup(t,completion,stream,modules=[]){
 const runtime=await createRuntime({storage:localContextStorage({path:':memory:'}),runner:nodeSubprocessCodeRunner,modules,context:{completion,maintenance:false},model:{id:'recovery',limits:{contextTokens:100000,inputTokens:90000,outputTokens:4096},estimate:async()=>({tokens:1000,precision:'exact',basis:'test'}),stream}})
 t.after(()=>runtime.close());return runtime.openSession('root')
}
async function run(session){const events=[];for await(const event of session.submit('Finish the task'))events.push(event);return events}

test('INV-28 domain rejection is returned to the next round and a verified repair can finish',async t=>{
 let calls=0; let checks=0
 const session=await setup(t,{verify:async()=>++checks===1?{verified:false,reason:'Test assertion still fails'}:{verified:true,reason:'Tests pass'}},async function*(request){if(++calls===2)assert.match(request.instructions,/Test assertion still fails/);yield* done(request)})
 const events=await run(session);assert.equal(events.at(-1).status,'completed');assert.equal(calls,2);assert.equal(events.filter(e=>e.type==='verification').length,2)
})

test('repeated domain failure is bounded and is reported as failure with the actual reason',async t=>{
 let calls=0
 const session=await setup(t,{verify:async()=>({verified:false,reason:'Required integration test fails'})},async function*(request){calls++;yield* done(request)})
 const events=await run(session);assert.equal(events.at(-1).status,'failed');assert.equal(calls,3);assert.equal(events.findLast(e=>e.type==='verification').recovery,'repair')
})

test('uncertain world effects stop in needs_reconcile without automatically replaying the script',async t=>{
 let writes=0; let calls=0
 const module={binding:{moduleId:'test:uncertain',instanceId:'one',generation:1,schemaRevision:'1'},summary:'uncertain',operations:{write:{summary:'write',input:{type:'null'},output:{type:'null'},effects:'write',run:()=>{writes++;throw Error('response lost')}}}}
 const session=await setup(t,undefined,async function*(request){if(++calls===1){yield turn(request,{execute:{source:"import {write} from 'test:uncertain';await write();"}});yield {type:'finish',reason:'stop'}}else yield* done(request)},[module])
 const events=await run(session);assert.equal(events.at(-1).status,'needs_reconcile');assert.equal(writes,1);assert.equal(calls,2);assert.equal((await session.inspect()).status,'needs_reconcile')
})
