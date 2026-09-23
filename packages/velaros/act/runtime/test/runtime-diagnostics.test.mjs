import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createContextRuntime} from '@velaros-ai/context'
import {localContextStorage} from '@velaros-ai/context/node'

import {RuntimeDiagnostics} from '../../../dist/act/runtime/impl/RuntimeDiagnostics.js'

test('INV-42 storage diagnostics preserve optional methods, detached results and original failures',async t=>{
 const underlying=localContextStorage({path:':memory:'});t.after(()=>underlying.close())
 const metrics=[]; const diagnostics=new RuntimeDiagnostics(underlying,metric=>metrics.push(metric))
 const context=createContextRuntime({sessionId:'s',storage:diagnostics.storage})
 const record=await context.append({kind:'user',body:'private input'})
 assert.equal((await context.read(record.ref)).text,'private input')
 assert.equal(diagnostics.storage.stores,underlying.stores)
 assert(metrics.some(metric=>metric.operation==='appendRecord'))
 const metadata=await diagnostics.storage.loadMetadata('s')
 assert.equal(await diagnostics.storage.compareAndSwapMetadata('s',metadata.version,{...metadata,version:metadata.version+1}),true)
 assert(metrics.some(metric=>metric.operation==='loadMetadata'))
 assert(metrics.some(metric=>metric.operation==='compareAndSwapMetadata'))
 const selected=await diagnostics.storage.selectSnapshot('s',[{refId:record.ref.id}])
 assert.deepEqual(selected.records[0].ref,record.ref)
 assert(metrics.some(metric=>metric.operation==='selectSnapshot'))
 assert.equal((await underlying.load('s')).records.length,1)
 assert(metrics.every(metric=>metric.durationMs>=0&&metric.succeeded&&Object.isFrozen(metric)))
 assert(!JSON.stringify(metrics).includes('private input'))
 const error=Error('storage failed'); const broken=new RuntimeDiagnostics({...diagnostics.storage,load:async()=>{throw error}},metric=>metrics.push(metric))
 await assert.rejects(broken.storage.load('s'),value=>value===error)
 assert.equal(metrics.at(-1).succeeded,false)
})

test('observers cannot change business results and optional capabilities remain optional',async()=>{
 const original={load:async()=>null,compareAndSwap:async()=>false,put:async()=>'',get:async()=>null,close:async()=>{}}
 assert.equal(new RuntimeDiagnostics(original,undefined).storage,original)
 for(const receiver of [()=>{throw Error('observer')},async()=>{throw Error('observer')}]){
  const diagnostics=new RuntimeDiagnostics(original,receiver)
  assert.equal(await diagnostics.storage.load('s'),null)
  assert.equal(diagnostics.storage.appendRecord,undefined)
  assert.equal(diagnostics.storage.loadMetadata,undefined)
  assert.equal(diagnostics.storage.selectSnapshot,undefined)
  assert.equal(diagnostics.storage.compareAndSwapMetadata,undefined)
  assert.equal(diagnostics.storage.records,undefined)
  assert.equal(diagnostics.storage.collect,undefined)
 }
 await new Promise(resolve=>setImmediate(resolve))
})
