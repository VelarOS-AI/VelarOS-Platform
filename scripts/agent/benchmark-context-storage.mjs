import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {performance} from 'node:perf_hooks'

import {createContextRuntime} from '../../packages/context/dist/index.js'
import {localContextStorage} from '../../packages/context/dist/node.js'

// 相同历史、持久性和追加负载比较可选快路径与通用 CAS；时间只报告，不作为跨机器门槛。
const directory=await mkdtemp(join(tmpdir(),'velaros-context-benchmark-'))
const samples=20
const results=[]
try{
 for(const history of [1000,10000])for(const mode of ['cas','append']){
  const storage=localContextStorage({path:join(directory,`${history}-${mode}.sqlite`)})
  try{
   const objectId=await storage.put('benchmark','evidence')
   const records=Array.from({length:history},(_,i)=>({ref:{sessionId:'benchmark',id:`r${i}`},sequence:i+1,kind:'audit',title:'seed',objectId,chars:8,sources:[],createdAt:'2026-01-01T00:00:00.000Z'}))
   assert(await storage.compareAndSwap('benchmark',0,{version:1,records,workingSet:{revision:0,cursor:0,items:[]}}))
   const port=mode==='append'?storage:{load:id=>storage.load(id),compareAndSwap:(...args)=>storage.compareAndSwap(...args),put:(...args)=>storage.put(...args),get:(...args)=>storage.get(...args),close:()=>storage.close()}
   const context=createContextRuntime({sessionId:'benchmark',storage:port})
   const durations=[]
   for(let i=0;i<samples;i++){
    const start=performance.now()
    const record=await context.append({kind:'audit',title:'sample',body:`sample ${i}`,sources:[records[0].ref]})
    durations.push(performance.now()-start)
    assert.equal(record.sequence,history+i+1)
   }
   const state=await storage.load('benchmark')
   assert.equal(state.records.length,history+samples);assert.equal(state.version,1+samples)
   durations.sort((a,b)=>a-b)
   results.push({history,mode,samples,p50Ms:durations[Math.floor(samples/2)],p95Ms:durations[Math.ceil(samples*.95)-1],totalMs:durations.reduce((a,b)=>a+b,0)})
  }finally{await storage.close()}
 }
 process.stdout.write(`${JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,results},null,2)}\n`)
}finally{await rm(directory,{recursive:true,force:true})}
