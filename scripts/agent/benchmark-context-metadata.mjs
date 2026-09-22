import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {performance} from 'node:perf_hooks'

import {createContextInvocationJournal,createContextRuntime,createContextView} from '../../packages/context/dist/index.js'
import {localContextStorage} from '../../packages/context/dist/node.js'

// 相同快照和真实 FULL 持久性下测量小状态更新；immediateLagMs 是本次操作期间的事件循环让出延迟。
const directory=await mkdtemp(join(tmpdir(),'velaros-metadata-benchmark-')),results=[],samples=20
try{
 for(const history of [1000,10000])for(const mode of ['full','incremental']){
  const storage=localContextStorage({path:join(directory,`${history}-${mode}.sqlite`)})
  try{
   const indexKey=JSON.stringify(['kernel-invocation-index','s']),objectId=await storage.put('s','evidence')
   const records=Array.from({length:history},(_,i)=>({ref:{sessionId:'s',id:`r${i}`},sequence:i+1,kind:'audit',title:'seed',objectId,chars:8,sources:[],createdAt:'2026-01-01T00:00:00.000Z'}))
   const empty={version:1,workingSet:{revision:0,cursor:0,items:[]}}
   assert(await storage.compareAndSwap('s',0,{...empty,records}))
   assert(await storage.compareAndSwap(indexKey,0,{...empty,records:records.map(record=>({...record,objectId:'',chars:0}))}))
   const port=mode==='incremental'?storage:{load:id=>storage.load(id),compareAndSwap:(...args)=>storage.compareAndSwap(...args),put:(...args)=>storage.put(...args),get:(...args)=>storage.get(...args),records:(...args)=>storage.records(...args),appendRecord:(...args)=>storage.appendRecord(...args),close:()=>storage.close()}
   const context=createContextRuntime({sessionId:'s',storage:port}),goal=await context.append({kind:'user',body:'goal'})
   const view=createContextView({sessionId:'s',storage:port,context,sources:[],limits:{modelCalls:1000,modelTokens:1000000,leaseMs:60000}})
   await view.begin(goal.ref)
   const journal=createContextInvocationJournal(port)
   const operations={renew:()=>view.renew(),reserve:()=>view.reserveModel('main',10),usage:()=>view.recordUsage(4,2),claim:i=>journal.claim({id:`new-${i}`,sessionId:'s',executionId:'benchmark',binding:{moduleId:'test:read',instanceId:'one',generation:1,schemaRevision:'1'},operation:'read',input:null,inputFingerprint:'null',requestFingerprint:`${i}`})}
   for(const [operation,run] of Object.entries(operations)){
    const durations=[],lags=[]
    for(let i=0;i<samples;i++){
     const started=performance.now(),wake=new Promise(resolve=>setImmediate(()=>resolve(performance.now()-started)))
     await run(i);durations.push(performance.now()-started);lags.push(await wake)
    }
    durations.sort((a,b)=>a-b);lags.sort((a,b)=>a-b)
    results.push({history,mode,operation,samples,p50Ms:durations[10],p95Ms:durations[18],immediateLagP95Ms:lags[18]})
   }
   assert.equal((await storage.load('s')).records.length,history+1)
   assert.equal((await view.inspect()).usage.mainCalls,samples)
   assert.equal((await view.inspect()).usage.inputTokens,samples*4)
   assert.equal((await storage.records(indexKey,{title:'benchmark'})).items.length,samples)
  }finally{await storage.close()}
 }
 process.stdout.write(`${JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,results},null,2)}\n`)
}finally{await rm(directory,{recursive:true,force:true})}
