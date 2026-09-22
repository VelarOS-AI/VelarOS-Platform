import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {createContextRuntime,createContextView} from '../../packages/context/dist/index.js'
import {localContextStorage} from '../../packages/context/dist/node.js'
import {ContextMemory} from '../../packages/velaros/dist/act/runtime/impl/ContextMemory.js'
import {memoryReference,noteEntry} from '../../packages/velaros/dist/act/runtime/utils/context-memory.js'

// 复现修复前的目录授权与材料召回路径，和当前路径使用同一数据库及相同返回值。
async function legacyNotes(storage){
 const snapshot=await storage.load('s'),reset=Math.max(snapshot.task?.startedSequence??0,snapshot.records.findLast(record=>record.title==='search:history-reset')?.sequence??0)
 const records=[...new Map(snapshot.records.filter(record=>record.sequence>reset&&record.title.startsWith('workspace:note:')).map(record=>[record.title,record])).values()]
 const notes=[]
 for(const record of records)notes.push({record,note:JSON.parse(await storage.get('s',record.objectId))})
 return {snapshot,reset,notes}
}
async function legacyCatalog(storage){
 const {snapshot,reset,notes}=await legacyNotes(storage),latest=new Map(notes.map(item=>[item.record.ref.id,item])),items=[]
 for(const record of snapshot.records){
  if(!memoryReference(snapshot,record.ref))continue
  const kind=record.title.startsWith('workspace:note:')?'notes':(record.kind==='user'||record.sequence<=reset)?'inputs':(record.title===`script:${record.ref.id}`||record.title==='shared:script')?'programs':/^script:.*:result$/u.test(record.title)?'results':(record.kind==='note'||record.title==='model-tool:delivery')?'artifacts':record.kind==='assistant'?'history':null
  if(!kind||kind==='notes'&&!latest.has(record.ref.id))continue
  const note=latest.get(record.ref.id);items.push({...record,...(note?noteEntry(note.note,record):{})})
 }
 return {items:items.slice(0,32),nextAfter:items.length>32?items[31].sequence:null}
}
const root=await mkdtemp(join(tmpdir(),'velaros-recall-benchmark-')),storage=localContextStorage({path:join(root,'context.sqlite')}),samples=7,results=[]
try{
 const records=[],empty=await storage.put('s','{}')
 const add=(kind,title,objectId,chars)=>{const record={ref:{sessionId:'s',id:crypto.randomUUID()},sequence:records.length+1,kind,title,objectId,chars,sources:[],createdAt:'2026-01-01T00:00:00.000Z'};records.push(record);return record}
 const goal=add('user','',await storage.put('s','goal'),4)
 for(let i=0;i<10000;i++)add('audit',`script:control:${i}`,empty,2)
 for(let i=0;i<64;i++){
  const body=JSON.stringify({key:`note${i}`,revision:1,title:`note${i}`,body:'material'.repeat(100),sources:[],resident:true,stamps:[],origin:'model-note'})
  add('note',`workspace:note:note${i}`,await storage.put('s',body),body.length)
 }
 for(let i=0;i<64;i++)add('assistant','',empty,2)
 assert(await storage.compareAndSwap('s',0,{version:1,records,workingSet:{revision:0,cursor:0,items:[]}}))
 let rows=0,bodies=0
 const port={load:async(...args)=>{const state=await storage.load(...args);rows+=state?.records.length??0;return state},compareAndSwap:(...args)=>storage.compareAndSwap(...args),put:(...args)=>storage.put(...args),get:(...args)=>{bodies++;return storage.get(...args)},close:()=>storage.close()}
 const indexed={...port,loadMetadata:(...args)=>storage.loadMetadata(...args),records:async(...args)=>{const page=await storage.records(...args);rows+=page.items.length;return page},selectSnapshot:async(...args)=>{const snapshot=await storage.selectSnapshot(...args);rows+=snapshot?.records.length??0;return snapshot}}
 const context=createContextRuntime({sessionId:'s',storage:indexed}),view=createContextView({sessionId:'s',context,storage:indexed,sources:[]}),memory=new ContextMemory('s',context,indexed,view,{},{}),signal=new AbortController().signal
 const legacyInput=async()=>{const state=await port.load('s');assert.equal(state.records.find(record=>record.ref.id===goal.ref.id).kind,'user');return context.read(goal.ref,{limit:100})}
 const operations={
  catalog:{before:()=>legacyCatalog(port),after:()=>memory.catalog({},signal)},
  materialRead:{before:async()=>{const {snapshot}=await legacyNotes(port);assert(memoryReference(snapshot,goal.ref));return legacyInput()},after:()=>memory.readMaterial(goal.ref,0,100,signal)},
  inputProjection:{before:async()=>{const raw=await legacyInput();const state=await port.load('s');assert(!state.inputSummaries?.length);return raw},after:()=>context.projectInput(goal.ref,100)},
 }
 for(const [operation,paths] of Object.entries(operations)){
  assert.deepEqual(await paths.before(),await paths.after())
  for(const [mode,run] of Object.entries(paths)){
   const durations=[],counts=[]
   for(let i=0;i<samples;i++){rows=0;bodies=0;const start=performance.now();await run();durations.push(performance.now()-start);counts.push({records:rows,bodies})}
   durations.sort((a,b)=>a-b);results.push({operation,mode,p50Ms:durations[3],maxMs:durations.at(-1),...counts[0]})
  }
 }
 process.stdout.write(`${JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,totalRecords:records.length,samples,results},null,2)}\n`)
}finally{await storage.close();await rm(root,{recursive:true,force:true})}
