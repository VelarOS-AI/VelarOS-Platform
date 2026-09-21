import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {test} from 'node:test'

import {createContextInvocationJournal,createContextRuntime} from '../dist/index.js'
import {localContextStorage} from '../dist/node.js'

async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'act-storage-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'context.sqlite')}
const empty={version:0,records:[],workingSet:{revision:0,cursor:0,items:[]}}

test('INV-7 索引记录保持原引用、分页和跨连接 CAS，元数据更新不重写历史',async t=>{
 const path=await fixture(t); const a=localContextStorage({path}); const b=localContextStorage({path});t.after(async()=>{await a.close();await b.close()})
 const context=createContextRuntime({sessionId:'s',storage:a}); const record=await context.append({kind:'user',title:'goal',body:'task'})
 const initial=await a.load('s'); const state={...initial,version:initial.version+1,workingSet:{...initial.workingSet,revision:1,items:[record.ref]}}
 const db=new DatabaseSync(path)
 db.exec("CREATE TRIGGER forbid_rewrite BEFORE UPDATE ON context_records BEGIN SELECT RAISE(ABORT,'history rewritten'); END")
 const outcomes=await Promise.all([a.compareAndSwap('s',initial.version,state),b.compareAndSwap('s',initial.version,state)])
 assert.equal(outcomes.filter(Boolean).length,1)
 assert.deepEqual((await b.records('s',{title:'goal'})).items,[record]);assert.deepEqual(await b.load('s'),state)
 assert.equal(JSON.parse(db.prepare('SELECT state FROM sessions WHERE id=?').get('s').state).records,undefined)
 assert.equal((await context.read(record.ref)).text,'task');db.close()
})

test('long directories keep the CAS state small and indexed pages cover every record exactly once',async t=>{
 const path=await fixture(t);const storage=localContextStorage({path});t.after(()=>storage.close())
 const objectId=await storage.put('s','immutable evidence')
 const records=Array.from({length:1200},(_,i)=>({ref:{sessionId:'s',id:`r${i}`},sequence:i+1,kind:'audit',title:i%2?'odd':'even',objectId,chars:18,sources:[],createdAt:new Date().toISOString()}))
 await storage.compareAndSwap('s',0,{...empty,version:1,records})
 const ids=[];let after=0
 do{const page=await storage.records('s',{after,limit:73,title:'odd'});ids.push(...page.items.map(r=>r.ref.id));after=page.nextAfter}while(after!==null)
 assert.equal(ids.length,600);assert.equal(new Set(ids).size,600)
 for(let version=1;version<=10;version++)assert(await storage.compareAndSwap('s',version,{...empty,version:version+1,records,workingSet:{revision:version,cursor:version,items:[]}}))
 const db=new DatabaseSync(path);const chars=Number(db.prepare('SELECT length(state) AS size FROM sessions WHERE id=?').get('s').size)
 assert(chars<500);assert.equal(db.prepare('SELECT count(*) AS n FROM context_records WHERE session=?').get('s').n,1200);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close()
 assert.equal((await storage.load('s')).records.length,1200)
 t.diagnostic(JSON.stringify({records:1200,metadataChars:chars,pageSize:73,filteredRecords:600}))
})

test('object collection is opt-in, version-checked, grace-protected and keeps every archived body',async t=>{
 const path=await fixture(t);const storage=localContextStorage({path});t.after(()=>storage.close())
 const context=createContextRuntime({sessionId:'s',storage});const record=await context.append({kind:'user',body:'retained task'})
 const orphan=await storage.put('s','unpublished candidate');const staged=await storage.put('s','candidate reused before publishing')
 const db=new DatabaseSync(path);db.prepare('UPDATE objects SET touched=1 WHERE session=?').run('s');db.close()
 await storage.put('s','candidate reused before publishing')
 const version=(await storage.load('s')).version; const before=Date.now()-7200000
 assert.deepEqual(await storage.collect('s',{expectedVersion:version,before}),{candidates:1,deleted:0});assert.equal(await storage.get('s',orphan),'unpublished candidate')
 await assert.rejects(storage.collect('s',{expectedVersion:version+1,before,dryRun:false}),{code:'CONTEXT_CONFLICT'})
 await assert.rejects(storage.collect('s',{expectedVersion:version,before:Date.now(),dryRun:false}),{code:'INVALID_RANGE'})
 assert.deepEqual(await storage.collect('s',{expectedVersion:version,before,dryRun:false}),{candidates:1,deleted:1})
 assert.equal(await storage.get('s',orphan),null);assert.equal((await context.read(record.ref)).text,'retained task');assert(await storage.get('s',staged))
})

test('journal execution lookup loads matching receipts rather than every session receipt',async t=>{
 const storage=localContextStorage({path:':memory:'});t.after(()=>storage.close());let reads=0
 const counted={load:id=>storage.load(id),compareAndSwap:(...args)=>storage.compareAndSwap(...args),put:(...args)=>storage.put(...args),get:(...args)=>{reads++;return storage.get(...args)},records:(...args)=>storage.records(...args),close:async()=>{}}
 const journal=createContextInvocationJournal(counted)
 for(let i=0;i<80;i++)await journal.claim({id:`i${i}`,sessionId:'s',executionId:i%10?'other':'wanted',binding:{moduleId:'test:read',instanceId:'one',generation:1,schemaRevision:'1'},operation:'read',input:null,inputFingerprint:'null',requestFingerprint:String(i)})
 reads=0;assert.equal((await journal.list('s','wanted')).length,8);assert.equal(reads,8)
})
