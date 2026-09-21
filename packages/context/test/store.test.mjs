import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {test} from 'node:test'

import {StoreLimits} from '../dist/index.js'
import {localContextStorage} from '../dist/node.js'
const mutation=(storeId,key,value,baseRevision=0)=>({store:storeId,key,value,baseRevision,actor:'a',operationId:crypto.randomUUID()})
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'store-'));const path=join(root,'state.sqlite');const a=localContextStorage({path}); const b=localContextStorage({path});t.after(async()=>{await a.close();await b.close();await rm(root,{recursive:true,force:true})});const storeId=(await a.stores.create({scope:'fixture',owner:'fixture',name:'work',operationId:'fixture'})).id;return {a,b,path,storeId}}

test('INV-8 对象独立于会话，跨连接可读、跨关闭重建持久化，返回值不共享内存',async t=>{
 const {a,b,path,storeId}=await fixture(t)
 const saved=await a.stores.commit(mutation(storeId,'finding',{nested:[1,'literal ` ${x} \\ 中文']}))
 saved.value.nested[0]=999
 assert.equal((await b.stores.get(storeId,'finding')).value.nested[0],1)
 const reopened=localContextStorage({path});try{assert.deepEqual((await reopened.stores.get(storeId,'finding')).value,{nested:[1,'literal ` ${x} \\ 中文']});assert.equal(await reopened.load(storeId),null)}finally{await reopened.close()}
 await a.collect(storeId,{expectedVersion:0,before:0,dryRun:false})
 assert.equal((await b.stores.get(storeId,'finding')).revision,1)
})
test('INV-8 并发 CAS 只有一个成功；删除重建保持单调版本',async t=>{
 const {a,b,storeId}=await fixture(t)
 await a.stores.commit(mutation(storeId,'x',0))
 const result=await Promise.allSettled([a.stores.commit(mutation(storeId,'x',1,1)),b.stores.commit(mutation(storeId,'x',2,1))])
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1)
 assert.equal(result.find(x=>x.status==='rejected').reason.code,'STORE_CONFLICT')
 const removed=await a.stores.commit({store:storeId,key:'x',remove:true,baseRevision:2,actor:'a',operationId:'delete'})
 assert.equal(removed.deleted,true);assert.equal(removed.revision,3)
 await assert.rejects(b.stores.commit(mutation(storeId,'x',3,0)),{code:'STORE_CONFLICT'})
 assert.equal((await b.stores.commit(mutation(storeId,'x',3,3))).revision,4)
})
test('INV-8 对象、事件和调用回执在同一事务内回滚',async t=>{
 const {a,b,path,storeId}=await fixture(t)
 const watch=await a.stores.watch(storeId,'reader',[],[''],'watch')
 const db=new DatabaseSync(path)
 try{db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON store_changes BEGIN SELECT RAISE(ABORT,'injected'); END")
  await assert.rejects(a.stores.commit({...mutation(storeId,'x',1),operationId:'broken'}),/injected/)
  assert.equal(await b.stores.get(storeId,'x'),null);assert.equal(await b.stores.receipt(storeId,'broken'),null)
  assert.equal((await b.stores.changes(storeId,'reader',[''])).head,watch.after)
  db.exec('DROP TRIGGER fail_event')
  assert.equal((await a.stores.commit(mutation(storeId,'x',1))).sequence,1)
 }finally{db.close()}
})
test('INV-8 丢失响应重试同一身份复用回执；身份冲突拒绝且相同值不制造事件',async t=>{
 const {a,b,storeId}=await fixture(t); const request={...mutation(storeId,'x',{b:2,a:1}),operationId:'once'}
 const first=await a.stores.commit(request)
 assert.deepEqual(await b.stores.commit({...request,value:{a:1,b:2}}),first)
 await assert.rejects(b.stores.commit({...request,value:3}),{code:'STORE_IDENTITY'})
 const noChange=await b.stores.commit(mutation(storeId,'x',{a:1,b:2},1))
 assert.equal(noChange.sequence,first.sequence);assert.equal(noChange.revision,1)
})
test('INV-9 持久订阅重启补收、重复投递直到确认，确认不吞掉之后的变化',async t=>{
 const {a,b,path,storeId}=await fixture(t)
 await a.stores.watch(storeId,'reader',['x'],[],'watch')
 await b.stores.commit(mutation(storeId,'x',1))
 const page=await a.stores.changes(storeId,'reader',[''])
 assert.equal(page.events[0].revision,1)
 const reopened=localContextStorage({path})
 try{assert.deepEqual(await reopened.stores.changes(storeId,'reader',['']),page)}finally{await reopened.close()}
 await b.stores.commit(mutation(storeId,'x',2,1))
 await a.stores.acknowledge(storeId,'reader',page.revision,page.through)
 const next=await b.stores.changes(storeId,'reader',[''])
 assert.equal(next.events.length,1);assert.equal(next.events[0].revision,2)
})
test('INV-9 订阅换代拒绝旧确认，重复关注声明保留待处理事件',async t=>{
 const {a,b,storeId}=await fixture(t)
 await a.stores.watch(storeId,'reader',['x'],[],'first')
 await b.stores.commit(mutation(storeId,'x',1))
 const before=await a.stores.changes(storeId,'reader',[''])
 await a.stores.watch(storeId,'reader',['x'],[],'repeat')
 assert.deepEqual(await a.stores.changes(storeId,'reader',['']),before)
 const next=await a.stores.watch(storeId,'reader',['y'],[],'change')
 await b.stores.commit(mutation(storeId,'y',1))
 await a.stores.acknowledge(storeId,'reader',before.revision,2)
 assert.equal((await a.stores.changes(storeId,'reader',[''])).after,next.after)
 await a.stores.watch(storeId,'reader',[],[],'clear')
 assert.equal(await a.stores.changes(storeId,'reader',['']),null)
})
test('INV-9 分页、合并与权限过滤不漏掉未交付事件',async t=>{
 const {a,b,storeId}=await fixture(t)
 await a.stores.watch(storeId,'reader',[],[''],'watch')
 for(const key of ['hidden/a','public/a','public/b','public/c'])await b.stores.commit(mutation(storeId,key,1))
 await b.stores.commit(mutation(storeId,'public/a',2,1))
 const first=await a.stores.changes(storeId,'reader',['public/'],2)
 assert.deepEqual(first.events.map(x=>x.key),['public/a','public/b']);assert.equal(first.hasMore,true)
 await a.stores.acknowledge(storeId,'reader',first.revision,first.through)
 const second=await a.stores.changes(storeId,'reader',['public/'],2)
 assert.deepEqual(second.events.map(x=>[x.key,x.revision]),[['public/c',1],['public/a',2]])
 const listing=await b.stores.list(storeId,{read:['public/'],limit:2})
 assert.deepEqual(listing.items.map(x=>x.key),['public/a','public/b']);assert(!Object.hasOwn(listing.items[0],'value'))
 assert.deepEqual((await b.stores.list(storeId,{read:['public/'],after:listing.nextAfter})).items.map(x=>x.key),['public/c'])
})
test('INV-9 超出变更保留窗口明确报告缺口，正文仍能读取',async t=>{
 const storage=localContextStorage({path:':memory:'});t.after(()=>storage.close())
 const storeId=(await storage.stores.create({scope:'fixture',owner:'fixture',name:'work',operationId:'fixture'})).id
 await storage.stores.watch(storeId,'reader',['x'],[],'watch')
 for(let i=0;i<StoreLimits.retainedEvents+2;i++)await storage.stores.commit(mutation(storeId,'x',i,i))
 const result=await storage.stores.changes(storeId,'reader',[''])
 assert.equal(result.gap,true);assert.equal(result.hasMore,true)
 assert.equal((await storage.stores.get(storeId,'x')).revision,StoreLimits.retainedEvents+2)
})
test('INV-9 跨连接等待可唤醒，取消释放等待',async t=>{
 const {a,b,storeId}=await fixture(t); const signal=new AbortController()
 const pending=a.stores.wait(storeId,0,signal.signal)
 await b.stores.commit(mutation(storeId,'x',1));await pending
 const cancelled=a.stores.wait(storeId,1,signal.signal);signal.abort(new Error('stop'))
 await assert.rejects(cancelled,/stop/)
})
test('INV-8 非 JSON 值、getter、循环与超大对象在提交前拒绝',async t=>{
 const {a,storeId}=await fixture(t);let getter=false
 const cycle={};cycle.self=cycle
 for(const value of [undefined,NaN,()=>1,cycle,new Map(),Object.assign(Array.from({length: 2}),{1:1}),{get value(){getter=true;return 1}},'x'.repeat(StoreLimits.valueBytes+1)])await assert.rejects(a.stores.commit(mutation(storeId,'x',value)),error=>['STORE_INPUT','STORE_LIMIT'].includes(error.code))
 assert.equal(getter,false);assert.equal(await a.stores.get(storeId,'x'),null)
})

test('INV-10 创建空间与调用身份幂等；同名独立、按边界和拥有者过滤目录',async t=>{
 const {a,b}=await fixture(t)
 const input={scope:'project',owner:'main',name:'work',description:'purpose',operationId:'create'}
 const [first,retry]=await Promise.all([a.stores.create(input),b.stores.create(input)])
 assert.equal(first.id,retry.id)
 await assert.rejects(a.stores.create({...input,name:'different'}),{code:'STORE_IDENTITY'})
 const second=await a.stores.create({...input,operationId:'second'})
 assert.notEqual(first.id,second.id)
 await a.stores.create({...input,owner:'private',operationId:'private'})
 assert.equal((await b.stores.directory('project','main',[])).items.length,2)
 assert.deepEqual((await b.stores.directory('elsewhere','main',[first.id])).items,[])
 assert.equal((await b.stores.directory('project','reader',[first.id])).items[0].id,first.id)
 const page=await b.stores.directory('project','main',[],undefined,1)
 assert(page.nextAfter);assert.notEqual((await b.stores.directory('project','main',[],page.nextAfter,1)).items[0].id,page.items[0].id)
 assert.equal((await b.stores.creation('project','main','create')).id,first.id)
 assert.equal(await b.stores.creation('project','reader','create'),null)
})
test('INV-10 归档撤回空间目录，正文和提交证据仍保留供宿主管理',async t=>{
 const {a,b,storeId}=await fixture(t)
 const store=await a.stores.create({scope:'project',owner:'main',name:'work',operationId:'create'})
 await a.stores.commit({...mutation(storeId,'x',1),store:store.id})
 await b.stores.archive('project',store.id)
 assert.deepEqual((await a.stores.directory('project','main',[])).items,[])
 assert.equal((await a.stores.describe('project',store.id)).archived,true)
 assert.equal((await a.stores.get(store.id,'x')).value,1)
})
test('INV-10 写入与订阅必须指向已创建的活动空间',async t=>{
 const {a,b,storeId}=await fixture(t)
 await assert.rejects(a.stores.commit({...mutation('missing','x',1),operationId:'missing-write'}),{code:'STORE_MISSING'})
 await assert.rejects(a.stores.watch('missing','reader',['x'],[],'missing-watch'),{code:'STORE_MISSING'})
 assert.equal(await b.stores.get('missing','x'),null)
 assert.equal(await b.stores.receipt('missing','missing-write'),null)
 assert.equal(await b.stores.receipt('missing','missing-watch'),null)
 assert.equal(await b.stores.changes('missing','reader',['']),null)
 const write={...mutation(storeId,'x',1),operationId:'write'}
 const committed=await a.stores.commit(write)
 const watched=await a.stores.watch(storeId,'reader',['x'],[],'watch')
 await a.stores.archive('fixture',storeId)
 await assert.rejects(b.stores.commit(mutation(storeId,'x',2,1)),{code:'STORE_DENIED'})
 await assert.rejects(b.stores.watch(storeId,'reader',['y'],[],'new-watch'),{code:'STORE_DENIED'})
 assert.deepEqual(await b.stores.commit(write),committed)
 assert.deepEqual(await b.stores.watch(storeId,'reader',['x'],[],'watch'),watched)
 assert.equal((await b.stores.get(storeId,'x')).revision,1)
})
test('INV-10 归档释放活动空间额度，历史对象仍保留',async t=>{
 const {a}=await fixture(t);let first
 for(let i=0;i<StoreLimits.stores;i++){
  const item=await a.stores.create({scope:'p',owner:'owner',name:'work',operationId:`create${i}`});first??=item.id
 }
 await assert.rejects(a.stores.create({scope:'p',owner:'owner',name:'next',operationId:'next'}),{code:'STORE_LIMIT'})
 await a.stores.archive('p',first)
 assert((await a.stores.create({scope:'p',owner:'owner',name:'next',operationId:'next'})).id)
 assert.equal((await a.stores.describe('p',first)).archived,true)
})

test('INV-11 独立消息不合并，跨重启补收，投递与逐条处理确认独立',async t=>{
 const {a,b,path,storeId}=await fixture(t)
 await a.stores.subscribe(storeId,'reader',['task/'],'subscribe')
 const input={store:storeId,topic:'task/progress',value:{phase:1},actor:'writer',operationId:'message-one'}
 const first=await b.stores.publish(input); const second=await b.stores.publish({...input,value:{phase:2},operationId:'message-two'})
 assert.deepEqual(await a.stores.publish(input),first)
 await assert.rejects(a.stores.publish({...input,value:2}),{code:'STORE_IDENTITY'})
 const page=await a.stores.messages(storeId,'reader',['task/'],{delivery:true})
 assert.deepEqual(page.events.map(item=>item.value.phase),[1,2]);assert.equal(page.pending,2)
 await a.stores.delivered(storeId,'reader',page.revision,page.through)
 const reopened=localContextStorage({path})
 try{
  assert.equal((await reopened.stores.messages(storeId,'reader',['task/'],{delivery:true})).events.length,0)
  assert.equal((await reopened.stores.messages(storeId,'reader',['task/'])).pending,2)
  const ack=await reopened.stores.acknowledgeEvents(storeId,'reader',['task/'],[second.id],'ack')
  assert.deepEqual(await b.stores.acknowledgeEvents(storeId,'reader',['task/'],[second.id],'ack'),ack)
  assert.deepEqual((await b.stores.messages(storeId,'reader',['task/'])).events.map(item=>item.id),[first.id])
 }finally{await reopened.close()}
})
test('INV-11 消息权限、订阅代次与窗口缺口都显式校验',async t=>{
 const {a,b,storeId}=await fixture(t)
 await a.stores.subscribe(storeId,'reader',[''],'sub')
 const privateEvent=await b.stores.publish({store:storeId,topic:'private',value:'hidden',actor:'writer',operationId:'private'})
 assert.deepEqual((await a.stores.messages(storeId,'reader',['public'])).events,[])
 await assert.rejects(a.stores.acknowledgeEvents(storeId,'reader',['public'],[privateEvent.id],'denied'),{code:'STORE_DENIED'})
 const old=await a.stores.messages(storeId,'reader',[''],{delivery:true})
 await a.stores.subscribe(storeId,'reader',['public'],'changed')
 await b.stores.publish({store:storeId,topic:'public',value:1,actor:'writer',operationId:'public'})
 await a.stores.delivered(storeId,'reader',old.revision,2)
 assert.equal((await a.stores.messages(storeId,'reader',['public'],{delivery:true})).events.length,1)
 await assert.rejects(a.stores.publish({store:storeId,topic:'public',value:'x'.repeat(StoreLimits.messageBytes),actor:'writer',operationId:'large'}),{code:'STORE_LIMIT'})
})
test('INV-11 对象更新与消息原子提交；任一步失败全部回滚',async t=>{
 const {a,b,path,storeId}=await fixture(t); const db=new DatabaseSync(path)
 try{
  await a.stores.subscribe(storeId,'reader',[''],'sub')
  db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON store_events BEGIN SELECT RAISE(ABORT,'message failed'); END")
  const input={...mutation(storeId,'task',{status:'ready'}),operationId:'atomic',event:{topic:'ready',value:{key:'task'}}}
  await assert.rejects(a.stores.commit(input),/message failed/)
  assert.equal(await b.stores.get(storeId,'task'),null);assert.equal(await b.stores.receipt(storeId,'atomic'),null)
  db.exec('DROP TRIGGER fail_message')
  await a.stores.commit(input);await b.stores.commit(input)
  assert.equal((await b.stores.messages(storeId,'reader',[''])).events.length,1)
  assert.equal((await b.stores.get(storeId,'task')).revision,1)
 }finally{db.close()}
})
test('INV-11 跨连接消息等待和取消使用真实持久消息头',async t=>{
 const {a,b,storeId}=await fixture(t); const control=new AbortController()
 const waiting=a.stores.waitEvents(storeId,0,control.signal)
 await b.stores.publish({store:storeId,topic:'ready',value:1,actor:'writer',operationId:'one'});await waiting
 const next=a.stores.waitEvents(storeId,1,control.signal);control.abort(new Error('stop'))
 await assert.rejects(next,/stop/)
})
test('INV-11 保留窗口外的消息缺口不会被伪装成成功处理',async t=>{
 const a=localContextStorage({path:':memory:'});t.after(()=>a.close())
 const id=(await a.stores.create({scope:'test',owner:'writer',name:'work',operationId:'create'})).id
 await a.stores.subscribe(id,'reader',[''],'sub')
 let first
 for(let i=0;i<StoreLimits.retainedEvents+1;i++){const event=await a.stores.publish({store:id,topic:'same',value:i,actor:'writer',operationId:String(i)});first??=event}
 const page=await a.stores.messages(id,'reader',[''],{delivery:true,limit:2})
 assert.equal(page.gap,true);assert.equal(page.pending,StoreLimits.retainedEvents);assert.equal(page.hasMore,true)
 await assert.rejects(a.stores.acknowledgeEvents(id,'reader',[''],[first.id],'late'),{code:'STORE_MISSING'})
})
