import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {createContextRuntime,createContextView} from '../../packages/context/dist/index.js'
import {localContextStorage} from '../../packages/context/dist/node.js'
import {ProgramContext} from '../../packages/velaros/dist/act/runtime/impl/ProgramContext.js'
import {ContextMemory} from '../../packages/velaros/dist/act/runtime/impl/ContextMemory.js'

// 用相同 SQLite 持久性和业务操作对比选择快照与完整快照；每组结束核对权威状态。
const root=await mkdtemp(join(tmpdir(),'velaros-query-benchmark-')),results=[],samples=20
try{
 for(const history of [1000,10000])for(const mode of ['full','indexed']){
  const storage=localContextStorage({path:join(root,`${history}-${mode}.sqlite`)})
  try{
   const objectId=await storage.put('s','seed'),records=Array.from({length:history},(_,i)=>({ref:{sessionId:'s',id:`r${i}`},sequence:i+1,kind:'audit',title:'background',objectId,chars:4,sources:[],createdAt:'2026-01-01T00:00:00.000Z'}))
   assert(await storage.compareAndSwap('s',0,{version:1,records,workingSet:{revision:0,cursor:0,items:[]}}))
   const port=mode==='indexed'?storage:{load:(...args)=>storage.load(...args),compareAndSwap:(...args)=>storage.compareAndSwap(...args),loadMetadata:(...args)=>storage.loadMetadata(...args),compareAndSwapMetadata:(...args)=>storage.compareAndSwapMetadata(...args),put:(...args)=>storage.put(...args),get:(...args)=>storage.get(...args),records:(...args)=>storage.records(...args),appendRecord:(...args)=>storage.appendRecord(...args),close:()=>storage.close()}
   const context=createContextRuntime({sessionId:'s',storage:port}),goal=await context.append({kind:'user',body:'goal'})
   const view=createContextView({sessionId:'s',storage:port,context,sources:[],limits:{leaseMs:60000}});await view.begin(goal.ref)
   const programs=new ProgramContext('s',context,port),memory=new ContextMemory('s',context,port,view,programs,{}),signal=new AbortController().signal
   await programs.observeHealth('source','seed',true,false)
   await context.append({kind:'audit',title:'script:version:source',body:JSON.stringify({sourceRef:'source',reason:'seed'})})
   await memory.update({key:'plan',baseRevision:0,body:'initial',sources:[goal.ref]},signal)
   const operations={programState:()=>programs.state(),programUpdate:i=>programs.observeHealth('source',`result${i}`,true,false),programVersion:()=>programs.version('source'),noteList:()=>memory.list({},signal),noteUpdate:i=>memory.update({key:'plan',baseRevision:i+1,body:`version${i}`},signal)}
   for(const [operation,run] of Object.entries(operations)){
    const durations=[],lags=[]
    for(let i=0;i<samples;i++){
     const started=performance.now(),wake=new Promise(resolve=>setImmediate(()=>resolve(performance.now()-started)))
     await run(i);durations.push(performance.now()-started);lags.push(await wake)
    }
    durations.sort((a,b)=>a-b);lags.sort((a,b)=>a-b)
    results.push({history,mode,operation,samples,p50Ms:durations[10],p95Ms:durations[18],immediateLagP95Ms:lags[18]})
   }
   assert.equal((await programs.state()).health.lastResult,'result19')
   assert.equal((await memory.list({},signal)).items[0].revision,samples+1)
   assert.equal((await storage.load('s')).records.length,history+1+1+1+1+samples*2)
  }finally{await storage.close()}
 }
 process.stdout.write(`${JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,results},null,2)}\n`)
}finally{await rm(root,{recursive:true,force:true})}
