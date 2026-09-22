import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {createContextRuntime,createContextView} from '../../packages/context/dist/index.js'
import {localContextStorage} from '../../packages/context/dist/node.js'
import {ProgramContext} from '../../packages/velaros/dist/act/runtime/impl/ProgramContext.js'
import {ContextMemory} from '../../packages/velaros/dist/act/runtime/impl/ContextMemory.js'
import {RecentContext} from '../../packages/velaros/dist/act/runtime/impl/RecentContext.js'

// 当前回退路径与索引路径使用相同持久性；重建 RecentContext 模拟每轮重新分类，warm 保留有界分类缓存。
const root=await mkdtemp(join(tmpdir(),'velaros-projection-benchmark-')),results=[],samples=20
try{
 for(const mode of ['full-cold','indexed-cold','indexed-warm']){
  const storage=localContextStorage({path:join(root,`${mode}.sqlite`)})
  try{
   const objectId=await storage.put('s','background'),records=Array.from({length:10000},(_,i)=>({ref:{sessionId:'s',id:`background-${i}`},sequence:i+1,kind:'audit',title:'background',objectId,chars:10,sources:[],createdAt:'2026-01-01T00:00:00.000Z'}))
   assert(await storage.compareAndSwap('s',0,{version:1,records,workingSet:{revision:0,cursor:0,items:[]}}))
   let bodyReads=0
   const port={load:(...args)=>storage.load(...args),loadMetadata:(...args)=>storage.loadMetadata(...args),compareAndSwap:(...args)=>storage.compareAndSwap(...args),compareAndSwapMetadata:(...args)=>storage.compareAndSwapMetadata(...args),records:(...args)=>storage.records(...args),appendRecord:(...args)=>storage.appendRecord(...args),put:(...args)=>storage.put(...args),get:(...args)=>{bodyReads++;return storage.get(...args)},close:()=>storage.close(),...(mode.startsWith('indexed')?{selectSnapshot:(...args)=>storage.selectSnapshot(...args)}:{})}
   const context=createContextRuntime({sessionId:'s',storage:port}),goal=await context.append({kind:'user',body:'goal'})
   const view=createContextView({sessionId:'s',storage:port,context,sources:[],limits:{leaseMs:60000}});await view.begin(goal.ref)
   for(let i=0;i<200;i++)await context.append({kind:'audit',title:`script:${crypto.randomUUID()}:result`,body:JSON.stringify({mode:i%2?'execute':'observe',index:i,body:'x'.repeat(1000)})})
   const programs=new ProgramContext('s',context,port),signal=new AbortController().signal
   let recent=new RecentContext('s',context,port)
   const memory=new ContextMemory('s',context,port,view,programs,recent)
   await memory.update({key:'plan',baseRevision:0,body:'note'},signal)
   const modelView={id:'view',scope:{sessionId:'s',revision:0},goals:[],capsule:{},mandatory:[],evidence:[],gaps:[],readSet:[],progress:{step:0,repeatedSteps:0,stalled:false,evidence:[]}}
   const frame={body:JSON.stringify({results:[],goals:[]}),images:[],prompt:''}
   for(const operation of ['programProjection','historyProjection','memoryProjection']){
    const durations=[],reads=[]
    for(let i=0;i<samples;i++){
     if(mode!=='indexed-warm')recent=new RecentContext('s',context,port)
     bodyReads=0;const started=performance.now()
     const result=operation==='programProjection'?await programs.project(modelView,undefined,[],signal,20000):operation==='historyProjection'?await recent.project(frame,4096,signal,8):await new ContextMemory('s',context,port,view,programs,recent).project(modelView,undefined,[],signal,20000)
     durations.push(performance.now()-started);reads.push(bodyReads)
     if(operation==='historyProjection'){assert.equal(result.history.length,9);assert.equal(JSON.parse(result.history[0].content).omittedRecords,92)}
     if(operation==='memoryProjection')assert.equal(JSON.parse(result.body).partitions.workspace.notes[0].text,'note')
    }
    durations.sort((a,b)=>a-b)
    results.push({mode,operation,samples,p50Ms:durations[10],p95Ms:durations[18],bodyReadsFirst:reads[0],bodyReadsLast:reads.at(-1)})
   }
  }finally{await storage.close()}
 }
 process.stdout.write(`${JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,backgroundRecords:10000,resultRecords:200,results},null,2)}\n`)
}finally{await rm(root,{recursive:true,force:true})}
