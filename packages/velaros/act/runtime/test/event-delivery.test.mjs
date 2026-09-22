import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEventDelivery } from '../../../dist/act/runtime/index.js'

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))

test('INV-40 delivery waits for persistence, preserves order and allows writes to batch',async()=>{
 const writes=[deferred(),deferred()];const started=[];const delivered=[]
 const lane=createEventDelivery({persist:async value=>{started.push(value);return writes[value-1].promise},deliver:value=>{delivered.push(value)}})
 const first=lane.append(1);const second=lane.append(2)
 let flushed=false;const flush=lane.flush().then(()=>{flushed=true})
 await tick();assert.deepEqual(started,[1,2]);assert.deepEqual(delivered,[])
 writes[1].resolve('second');await tick();assert.deepEqual(delivered,[]);assert.equal(flushed,false)
 writes[0].resolve('first');await Promise.all([first,second,flush]);assert.deepEqual(delivered,['first','second']);assert.equal(flushed,true)
})

test('persistence failure stops later delivery and close waits for every in-flight write',async()=>{
 const writes=[deferred(),deferred()];const delivered=[];const failure=Error('disk failed')
 const lane=createEventDelivery({persist:value=>writes[value].promise,deliver:value=>delivered.push(value)})
 const result=Promise.allSettled([lane.append(0),lane.append(1)])
 let closed=false;const close=lane.close().catch(error=>{closed=true;assert.equal(error,failure)})
 writes[0].reject(failure);await tick();assert.equal(closed,false)
 writes[1].resolve('persisted second');await close
 assert((await result).every(item=>item.status==='rejected'&&item.reason===failure));assert.deepEqual(delivered,[])
 await assert.rejects(lane.flush(),error=>error===failure);await assert.rejects(lane.close(),error=>error===failure)
 await assert.rejects(lane.append(2),/关闭/)
})

test('transport failure cannot allow a later terminal receipt through',async()=>{
 const delivered=[];const failure=Error('disconnected');let writes=0
 const lane=createEventDelivery({persist:async value=>{writes++;return value},deliver:async value=>{delivered.push(value);throw failure}})
 const result=await Promise.allSettled([lane.append('body'),lane.append('done')])
 assert(result.every(item=>item.status==='rejected'&&item.reason===failure));assert.deepEqual(delivered,['body']);assert.equal(writes,2)
 await assert.rejects(lane.append('later'),error=>error===failure);assert.equal(writes,2)
})

test('input mutation cannot change queued data and close seals immediately',async()=>{
 const write=deferred();const delivery=deferred();const delivered=[]
 const lane=createEventDelivery({persist:async value=>{await write.promise;return value},deliver:async value=>{delivered.push(value);await delivery.promise}})
 const value={text:'original'};const append=lane.append(value);value.text='mutated'
 let finished=false;const close=lane.close().then(()=>{finished=true})
 await assert.rejects(lane.append({text:'late'}),/关闭/)
 write.resolve();await tick();assert.deepEqual(delivered,[{text:'original'}]);assert.equal(finished,false)
 delivery.resolve();await Promise.all([append,close]);await lane.close()
})

test('uncloneable input rejects and poisons later delivery without unhandled rejection',async()=>{
 const delivered=[]
 const lane=createEventDelivery({persist:async value=>value,deliver:value=>delivered.push(value)})
 const result=await Promise.allSettled([lane.append(()=>{}),lane.append('done')])
 assert(result.every(item=>item.status==='rejected'));assert.deepEqual(delivered,[]);await assert.rejects(lane.flush())
})
