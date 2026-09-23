import assert from 'node:assert/strict'
import {test} from 'node:test'

import {EffectScheduler} from '../../../dist/act/runtime/impl/EffectScheduler.js'

const signal=new AbortController().signal
const tick=()=>new Promise(resolve=>setImmediate(resolve))

test('INV-41 disjoint resources overlap; a shared resource waits until the real holder releases',async()=>{
 const scheduler=new EffectScheduler()
 const a=await scheduler.acquire(['a'],signal)
 const b=await scheduler.acquire(['b'],signal)
 let entered=false
 const shared=scheduler.acquire(['a','b'],signal).then(release=>{entered=true;return release})
 await tick();assert.equal(entered,false)
 a();await tick();assert.equal(entered,false)
 b();(await shared)()
})

test('a global waiter fences later writes even when their resource is disjoint',async()=>{
 const scheduler=new EffectScheduler(); const order=[]
 const a=await scheduler.acquire(['a'],signal)
 const global=scheduler.acquire(undefined,signal).then(release=>{order.push('global');return release})
 const b=scheduler.acquire(['b'],signal).then(release=>{order.push('b');return release})
 await tick();assert.deepEqual(order,[])
 a();const release=await global;await tick();assert.deepEqual(order,['global'])
 release();(await b)();assert.deepEqual(order,['global','b'])
})

test('cancelling a queued bridge frees independent resources without releasing active effects',async()=>{
 const scheduler=new EffectScheduler(); const controller=new AbortController()
 const a=await scheduler.acquire(['a'],signal)
 const bridge=assert.rejects(scheduler.acquire(['a','b'],controller.signal),/cancelled/)
 let same=false
 const next=scheduler.acquire(['a'],signal).then(release=>{same=true;return release})
 controller.abort(Error('cancelled'));await bridge
 const b=await scheduler.acquire(['b'],signal);b()
 await tick();assert.equal(same,false)
 a();(await next)()
 const held=new AbortController(); const release=await scheduler.acquire(['a'],held.signal)
 held.abort();let entered=false
 const later=scheduler.acquire(['a'],signal).then(unlock=>{entered=true;return unlock})
 await tick();assert.equal(entered,false)
 release();(await later)()
})

test('invalid scopes and pre-aborted calls never retain a queue entry',async()=>{
 const scheduler=new EffectScheduler()
 await assert.rejects(scheduler.acquire([],signal),/资源/)
 await assert.rejects(scheduler.acquire([''],signal),/资源/)
 await assert.rejects(scheduler.acquire(['a'],AbortSignal.abort(Error('stopped'))),/stopped/)
 ;(await scheduler.acquire(undefined,signal))()
})
