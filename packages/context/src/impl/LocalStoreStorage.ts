import {createHash} from 'node:crypto'
import type {DatabaseSync} from 'node:sqlite'

import {isUndefined,toNullable} from '@velaros-ai/core'
import { isArray, isEmpty, isString } from '@velaros-ai/core'
import {TimerScope} from '@velaros-ai/core/utils/TimerScope'

import { StoreLimits } from '../contract/constants.js'
import type {StoreStorage} from '../contract/requires.js'
import type {StoreChange,StoreChanges,StoreCreate,StoreDescriptor,StoreDirectory,StoreEvent,StoreEventAck,StoreEventPage,StoreMutation,StoreObject,StorePage,StorePublish,StoreSubscription,StoreWatch} from '../types/store.js'
import {storeFailure,storeJson,storeMatches,storeMessageJson,storeName,storeSelection} from '../utils/store.js'

import {createTurnContextAppendHub} from './TurnContextAppendHub.js'

/** 在已有 SQLite 连接内原子提交共享对象、变更记录、订阅与调用回执。 */
export class LocalStoreStorage implements StoreStorage {
 private readonly hub=createTurnContextAppendHub()
 public constructor(private readonly db:DatabaseSync,private readonly lifetime:AbortSignal){
  db.exec(`CREATE TABLE IF NOT EXISTS store_event_heads(store TEXT PRIMARY KEY,head INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS store_events(store TEXT NOT NULL,sequence INTEGER NOT NULL,id TEXT NOT NULL,topic TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(store,sequence),UNIQUE(store,id));
CREATE TABLE IF NOT EXISTS store_subscriptions(store TEXT NOT NULL,consumer TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(store,consumer));
CREATE TABLE IF NOT EXISTS store_event_acks(store TEXT NOT NULL,consumer TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(store,consumer,id));
CREATE TABLE IF NOT EXISTS store_heads(store TEXT PRIMARY KEY,head INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS store_objects(store TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(store,key));
CREATE TABLE IF NOT EXISTS store_changes(store TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(store,sequence));
CREATE TABLE IF NOT EXISTS store_consumers(store TEXT NOT NULL,consumer TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(store,consumer));
CREATE TABLE IF NOT EXISTS store_commits(store TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(store,id));
CREATE TABLE IF NOT EXISTS store_catalog(id TEXT PRIMARY KEY,scope TEXT NOT NULL,owner TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS store_owner ON store_catalog(scope,owner,id);
CREATE TABLE IF NOT EXISTS store_creations(scope TEXT NOT NULL,owner TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,owner,operation));`)
 }
 public async create(input:StoreCreate):Promise<StoreDescriptor>{
  storeName(input.scope,StoreLimits.scopeChars);storeName(input.owner,StoreLimits.scopeChars);storeName(input.operationId,4096);storeName(input.name,StoreLimits.nameChars)
  if(!isString(((input.description??'')))||(input.description?.length??0)>StoreLimits.descriptionChars)throw storeFailure('STORE_INPUT','空间说明过长')
  const fingerprint=JSON.stringify([input.name,input.description??''])
  return this.transaction(()=>{
   const prior=this.db.prepare('SELECT fingerprint,body FROM store_creations WHERE scope=? AND owner=? AND operation=?').get(input.scope,input.owner,input.operationId)
   if(prior){if(prior.fingerprint!==fingerprint)throw storeFailure('STORE_IDENTITY','同一调用不能创建不同空间');return JSON.parse(String(prior.body))}
   const count=Number(this.db.prepare("SELECT count(*) AS n FROM store_catalog WHERE scope=? AND owner=? AND json_extract(body,'$.archived')=0").get(input.scope,input.owner)?.n??0)
   if(count>=StoreLimits.stores)throw storeFailure('STORE_LIMIT','创建者空间额度已满')
   const store:StoreDescriptor={id:crypto.randomUUID(),name:input.name,description:input.description??'',owner:input.owner,createdAt:new Date().toISOString(),archived:false}
   this.db.prepare('INSERT INTO store_catalog(id,scope,owner,body) VALUES(?,?,?,?)').run(store.id,input.scope,input.owner,JSON.stringify(store))
   this.db.prepare('INSERT INTO store_creations(scope,owner,operation,fingerprint,body) VALUES(?,?,?,?,?)').run(input.scope,input.owner,input.operationId,fingerprint,JSON.stringify(store))
   return store
  })
 }
 public async creation(scope:string,owner:string,operationId:string):Promise<Nullable<StoreDescriptor>>{
  const row=this.db.prepare('SELECT body FROM store_creations WHERE scope=? AND owner=? AND operation=?').get(scope,owner,operationId)
  return row?JSON.parse(String(row.body)):null
 }
 public async describe(scope:string,id:string):Promise<Nullable<StoreDescriptor>>{
  const row=this.db.prepare('SELECT body FROM store_catalog WHERE scope=? AND id=?').get(scope,id)
  return row?JSON.parse(String(row.body)):null
 }
 public async directory(scope:string,owner:string,ids:readonly string[],after='',limit:number=StoreLimits.page):Promise<StoreDirectory>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>StoreLimits.maxPage||ids.length>StoreLimits.stores)throw storeFailure('STORE_INPUT','空间目录分页或授权数量无效')
  const rows=this.db.prepare(`SELECT body FROM store_catalog WHERE scope=? AND id>? AND (owner=?${ids.length?` OR id IN (${ids.map(()=>'?').join(',')})`:''}) AND json_extract(body,'$.archived')=0 ORDER BY id LIMIT ?`).all(scope,after,owner,...ids,limit+1)
  const items=rows.slice(0,limit).map(row=>JSON.parse(String(row.body)) as StoreDescriptor)
  return {items,nextAfter:rows.length>limit?items.at(-1)!.id:null}
 }
 public async archive(scope:string,id:string):Promise<void>{
  this.transaction(()=>{
   const row=this.db.prepare('SELECT body FROM store_catalog WHERE scope=? AND id=?').get(scope,id)
   if(!row)throw storeFailure('STORE_MISSING','空间不存在')
   this.db.prepare('UPDATE store_catalog SET body=? WHERE scope=? AND id=?').run(JSON.stringify({...JSON.parse(String(row.body)),archived:true}),scope,id)
  })
 }
 public async get(store:string,key:string):Promise<Nullable<StoreObject>>{
  storeName(store,StoreLimits.scopeChars);storeName(key,StoreLimits.keyChars)
  return this.object(store,key)
 }
 public async list(store:string,query:{read:readonly string[];prefix?:string;after?:string;limit?:number}):Promise<StorePage>{
  storeName(store,StoreLimits.scopeChars)
  const limit=query.limit??StoreLimits.page
  if(!Number.isSafeInteger(limit)||limit<1||limit>StoreLimits.maxPage)throw storeFailure('STORE_INPUT','状态目录分页范围无效')
  const clauses=['store=?','key>?']; const params:Array<string|number>=[store,query.after??'']
  const prefixes=query.read.filter(prefix=>prefix.startsWith(query.prefix??'')||(query.prefix??'').startsWith(prefix)).map(prefix=>prefix.length>(query.prefix?.length??0)?prefix:query.prefix??'')
  if(isEmpty(prefixes))return {items:[],nextAfter:null}
  clauses.push(`(${prefixes.map(()=>"substr(key,1,length(?))=?").join(' OR ')})`)
  for(const prefix of prefixes)params.push(prefix,prefix)
  const rows=this.db.prepare(`SELECT body FROM store_objects WHERE ${clauses.join(' AND ')} ORDER BY key LIMIT ?`).all(...params,limit+1)
  const items=rows.slice(0,limit).map(row=>{const {value:_value,...card}=JSON.parse(String(row.body)) as StoreObject;return card})
  return {items,nextAfter:rows.length>limit?items.at(-1)!.key:null}
 }
 public async commit(input:StoreMutation):Promise<StoreObject>{
  storeName(input.store,StoreLimits.scopeChars);storeName(input.key,StoreLimits.keyChars)
  storeName(input.actor,StoreLimits.scopeChars);storeName(input.operationId,4096)
  if(!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0)throw storeFailure('STORE_INPUT','写入需要非负整数 baseRevision')
  if(input.remove&&Object.hasOwn(input,'value'))throw storeFailure('STORE_INPUT','删除不能携带正文')
  const value=input.remove?'null':storeJson(input.value!)
  const event=input.event?{topic:input.event.topic,value:storeMessageJson(input.event.topic,input.event.value)}:undefined
  const fingerprint=createHash('sha256').update(JSON.stringify([input.key,input.baseRevision,Boolean(input.remove),value,input.actor,event])).digest('hex')
  const result=this.transaction(()=>{
   const prior=this.committed(input.store,input.operationId,'object',fingerprint)
   if(prior)return JSON.parse(prior) as StoreObject
   this.writable(input.store)
   const old=this.object(input.store,input.key)
   if((old?.revision??0)!==input.baseRevision)throw storeFailure('STORE_CONFLICT',`对象 ${input.key} 当前版本为 ${old?.revision??0}，请重新读取后提交`)
   let next:StoreObject
   if(old&&old.deleted===Boolean(input.remove)&&JSON.stringify(old.value)===value)next=old
   else{
    const sequence=this.head(input.store)+1
    next={key:input.key,revision:(old?.revision??0)+1,deleted:Boolean(input.remove),value:JSON.parse(value),updatedAt:new Date().toISOString(),actor:input.actor,sequence}
    this.db.prepare('INSERT INTO store_heads(store,head) VALUES(?,?) ON CONFLICT(store) DO UPDATE SET head=excluded.head').run(input.store,sequence)
    this.db.prepare('INSERT INTO store_objects(store,key,body) VALUES(?,?,?) ON CONFLICT(store,key) DO UPDATE SET body=excluded.body').run(input.store,input.key,JSON.stringify(next))
    const {value:_value,...card}=next
    this.db.prepare('INSERT INTO store_changes(store,sequence,body) VALUES(?,?,?)').run(input.store,sequence,JSON.stringify({...card,type:'store.changed'}))
    this.db.prepare('DELETE FROM store_changes WHERE store=? AND sequence<=?').run(input.store,sequence-StoreLimits.retainedEvents)
   }
   if(event)this.appendEvent(input.store,event.topic,event.value,input.actor)
   this.saveCommit(input.store,input.operationId,'object',fingerprint,next)
   return next
  })
  this.hub.emit(input.store,'store')
  return result
 }
 public async receipt(store:string,operationId:string):Promise<Nullable<StoreObject | StoreWatch | StoreEvent | StoreSubscription | StoreEventAck>>{
  const row=this.db.prepare("SELECT body FROM store_commits WHERE store=? AND id=?").get(store,operationId)
  return row?JSON.parse(String(row.body)):null
 }
 public async watch(store:string,consumer:string,keys:readonly string[],prefixes:readonly string[],operationId:string):Promise<StoreWatch>{
  storeName(store,StoreLimits.scopeChars);storeName(consumer,4096);storeName(operationId,4096)
  const selection=storeSelection(keys,prefixes); const fingerprint=JSON.stringify([consumer,selection])
  return this.transaction(()=>{
   const committed=this.committed(store,operationId,'watch',fingerprint)
   if(committed)return JSON.parse(committed) as StoreWatch
   this.writable(store)
   const old=this.consumer(store,consumer)
   const same=old&&JSON.stringify([old.keys,old.prefixes])===JSON.stringify([selection.keys,selection.prefixes])
   const next:StoreWatch=same?old:{...selection,revision:(old?.revision??0)+1,after:this.head(store)}
   this.db.prepare('INSERT INTO store_consumers(store,consumer,body) VALUES(?,?,?) ON CONFLICT(store,consumer) DO UPDATE SET body=excluded.body').run(store,consumer,JSON.stringify(next))
   this.saveCommit(store,operationId,'watch',fingerprint,next)
   return next
  })
 }
 public async changes(store:string,consumer:string,read:readonly string[],limit:number=StoreLimits.page):Promise<Nullable<StoreChanges>>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>StoreLimits.maxPage)throw storeFailure('STORE_INPUT','变更分页范围无效')
  return this.transaction(()=>{
   const watch=this.consumer(store,consumer)
   if(!watch||isEmpty(watch.keys)&&isEmpty(watch.prefixes))return null
   const head=this.head(store); const floor=Math.max(0,head-StoreLimits.retainedEvents); const after=watch.after
   let through=Math.max(after,floor)
   const rows=this.db.prepare('SELECT body FROM store_changes WHERE store=? AND sequence>? ORDER BY sequence LIMIT ?').all(store,through,StoreLimits.scanEvents)
   const selected=new Map<string,StoreChange>()
   for(const row of rows){
    const event=JSON.parse(String(row.body)) as StoreChange
    if(storeMatches(event.key,read)&&(watch.keys.includes(event.key)||storeMatches(event.key,watch.prefixes))){
     if(!selected.has(event.key)&&selected.size===limit)break
     selected.set(event.key,event)
    }
    through=event.sequence
   }
   return {revision:watch.revision,after,through,head,events:[...selected.values()].sort((a,b)=>a.sequence-b.sequence),gap:after<floor,hasMore:through<head}
  })
 }
 public async acknowledge(store:string,consumer:string,revision:number,through:number):Promise<void>{
  this.transaction(()=>{
   const watch=this.consumer(store,consumer)
   if(!watch||watch.revision!==revision)return
   if(!Number.isSafeInteger(through)||through<0||through>this.head(store))throw storeFailure('STORE_INPUT','订阅确认位置无效')
   if(through<=watch.after)return
   this.db.prepare('UPDATE store_consumers SET body=? WHERE store=? AND consumer=?').run(JSON.stringify({...watch,after:through}),store,consumer)
  })
 }
 public async wait(store:string,after:number,callerSignal:AbortSignal):Promise<void>{
  const signal=AbortSignal.any([callerSignal,this.lifetime])
  while(true){
   signal.throwIfAborted()
   if(this.head(store)>after)return
   await new Promise<void>((resolve,reject)=>{
    const timers=new TimerScope({name:"StoreWait"})
    const finish=(error?:unknown)=>{timers.dispose();unsubscribe();signal.removeEventListener('abort',abort);error?reject(error):resolve()}
    const abort=()=>finish(signal.reason??new Error('状态等待已取消'))
    const unsubscribe=this.hub.subscribe(changed=>{if(changed===store)finish()})
    timers.after(StoreLimits.pollMs,()=>finish())
    signal.addEventListener('abort',abort,{once:true})
    if(signal.aborted)abort()
   })
  }
 }
 public async publish(input:StorePublish):Promise<StoreEvent>{
  storeName(input.store,StoreLimits.scopeChars);storeName(input.topic,StoreLimits.keyChars);storeName(input.actor,StoreLimits.scopeChars);storeName(input.operationId,4096)
  const value=storeMessageJson(input.topic,input.value)
  const fingerprint=JSON.stringify([input.topic,value,input.actor])
  const event=this.transaction(()=>{
   const prior=this.committed(input.store,input.operationId,'event',fingerprint)
   if(prior)return JSON.parse(prior) as StoreEvent
   this.writable(input.store)
   const next=this.appendEvent(input.store,input.topic,value,input.actor)
   this.saveCommit(input.store,input.operationId,'event',fingerprint,next)
   return next
  })
  this.hub.emit(input.store,'message');return event
 }
 public async subscribe(store:string,consumer:string,topics:readonly string[],operationId:string,after?:number):Promise<StoreSubscription>{
  storeName(store,StoreLimits.scopeChars);storeName(consumer,4096);storeName(operationId,4096)
  const selected=storeSelection([],topics).prefixes; const fingerprint=JSON.stringify([consumer,selected,toNullable(after)])
  return this.transaction(()=>{
   const prior=this.committed(store,operationId,'subscribe',fingerprint)
   if(prior)return JSON.parse(prior) as StoreSubscription
   this.writable(store)
   const head=this.eventHead(store)
   if(!isUndefined(after)&&(!Number.isSafeInteger(after)||after<0||after>head))throw storeFailure('STORE_INPUT','消息订阅起点无效')
   const old=this.subscription(store,consumer)
   const same=old&&JSON.stringify(old.topics)===JSON.stringify(selected)&&isUndefined(after)
   const next:StoreSubscription=same?old:{revision:(old?.revision??0)+1,start:after??head,after:after??head,topics:selected}
   this.db.prepare('INSERT INTO store_subscriptions(store,consumer,body) VALUES(?,?,?) ON CONFLICT(store,consumer) DO UPDATE SET body=excluded.body').run(store,consumer,JSON.stringify(next))
   this.saveCommit(store,operationId,'subscribe',fingerprint,next);return next
  })
 }
 public async messages(store:string,consumer:string,read:readonly string[],query:{after?:number;limit?:number;pending?:boolean;delivery?:boolean}={}):Promise<Nullable<StoreEventPage>>{
  const limit=query.limit??StoreLimits.page
  if(!Number.isSafeInteger(limit)||limit<1||limit>StoreLimits.maxPage||!isUndefined(query.after)&&(!Number.isSafeInteger(query.after)||query.after<0))throw storeFailure('STORE_INPUT','消息分页无效')
  return this.transaction(()=>{
   const sub=this.subscription(store,consumer)
   if(!sub||isEmpty(sub.topics))return null
   const head=this.eventHead(store); const floor=Math.max(0,head-StoreLimits.retainedEvents); const after=query.delivery?sub.after:query.after??sub.start
   if(after>head)throw storeFailure('STORE_INPUT','消息游标超过当前消息头')
   if(!read.length)return {revision:sub.revision,after,through:head,head,events:[],pending:0,gap:after<floor,hasMore:false}
   const clause=(prefixes:readonly string[])=>`(${prefixes.map(()=>"substr(e.topic,1,length(?))=?").join(' OR ')})`
   const from=`FROM store_events e LEFT JOIN store_event_acks a ON a.store=e.store AND a.id=e.id AND a.consumer=? WHERE e.store=? AND ${clause(read)} AND ${clause(sub.topics)}`
   const parameters=[consumer,store,...read.flatMap(prefix=>[prefix,prefix]),...sub.topics.flatMap(prefix=>[prefix,prefix])]
   const pending=Number(this.db.prepare(`SELECT count(*) AS n ${from} AND e.sequence>? AND a.id IS NULL`).get(...parameters,sub.start)?.n??0)
   const rows=this.db.prepare(`SELECT e.body ${from} AND e.sequence>? ${(query.pending??true)?'AND a.id IS NULL':''} ORDER BY e.sequence LIMIT ?`).all(...parameters,after,limit+1)
   const events=rows.slice(0,limit).map(row=>JSON.parse(String(row.body)) as StoreEvent); const hasMore=rows.length>limit
   return {revision:sub.revision,after,through:hasMore?events.at(-1)!.sequence:head,head,events,pending,gap:after<floor,hasMore}

  })
 }
 public async delivered(store:string,consumer:string,revision:number,through:number):Promise<void>{
  this.transaction(()=>{
   const sub=this.subscription(store,consumer)
   if(!sub||sub.revision!==revision)return
   if(!Number.isSafeInteger(through)||through<0||through>this.eventHead(store))throw storeFailure('STORE_INPUT','消息投递游标无效')
   if(through>sub.after)this.db.prepare('UPDATE store_subscriptions SET body=? WHERE store=? AND consumer=?').run(JSON.stringify({...sub,after:through}),store,consumer)
  })
 }
 public async acknowledgeEvents(store:string,consumer:string,read:readonly string[],ids:readonly string[],operationId:string):Promise<StoreEventAck>{
  storeName(operationId,4096)
  if(!isArray(ids)||!ids.length||ids.length>StoreLimits.maxPage)throw storeFailure('STORE_INPUT','消息确认数量无效')
  for(const id of ids)storeName(id,StoreLimits.keyChars)
  const selected=[...new Set<string>(ids as readonly string[])].sort(); const fingerprint=JSON.stringify([consumer,selected])
  return this.transaction(()=>{
   const prior=this.committed(store,operationId,'event-ack',fingerprint)
   if(prior)return JSON.parse(prior) as StoreEventAck
   this.writable(store)
   const sub=this.subscription(store,consumer)
   for(const id of selected){
    const row=this.db.prepare('SELECT topic FROM store_events WHERE store=? AND id=?').get(store,id)
    if(!row)throw storeFailure('STORE_MISSING','消息不存在或已离开保留窗口，请先核对缺口')
    if(!sub||!storeMatches(String(row.topic),read)||!storeMatches(String(row.topic),sub.topics))throw storeFailure('STORE_DENIED','消息不在当前订阅授权内')
    this.db.prepare('INSERT OR IGNORE INTO store_event_acks(store,consumer,id) VALUES(?,?,?)').run(store,consumer,id)
   }
   const result={ids:selected};this.saveCommit(store,operationId,'event-ack',fingerprint,result);return result
  })
 }
 public async waitEvents(store:string,after:number,callerSignal:AbortSignal):Promise<void>{
  const signal=AbortSignal.any([callerSignal,this.lifetime])
  while(true){
   signal.throwIfAborted()
   if(this.eventHead(store)>after)return
   await new Promise<void>((resolve,reject)=>{
    const timers=new TimerScope({name:"StoreWait"})
    const finish=(error?:unknown)=>{timers.dispose();unsubscribe();signal.removeEventListener('abort',abort);error?reject(error):resolve()}
    const abort=()=>finish(signal.reason??new Error('消息等待已取消'))
    const unsubscribe=this.hub.subscribe(changed=>{if(changed===store)finish()})
    timers.after(StoreLimits.pollMs,()=>finish())
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
   })
  }
 }
 private appendEvent(store:string,topic:string,value:string,actor:string):StoreEvent{
  const sequence=this.eventHead(store)+1; const next:StoreEvent={id:crypto.randomUUID(),sequence,topic,value:JSON.parse(value),actor,createdAt:new Date().toISOString()}
  this.db.prepare('INSERT INTO store_event_heads(store,head) VALUES(?,?) ON CONFLICT(store) DO UPDATE SET head=excluded.head').run(store,sequence)
  this.db.prepare('INSERT INTO store_events(store,sequence,id,topic,body) VALUES(?,?,?,?,?)').run(store,sequence,next.id,topic,JSON.stringify(next))
  this.db.prepare('DELETE FROM store_events WHERE store=? AND sequence<=?').run(store,sequence-StoreLimits.retainedEvents)
  this.db.prepare('DELETE FROM store_event_acks WHERE store=? AND id NOT IN (SELECT id FROM store_events WHERE store=?)').run(store,store)
  return next
 }
 private subscription(store:string,consumer:string):Nullable<StoreSubscription>{const row=this.db.prepare('SELECT body FROM store_subscriptions WHERE store=? AND consumer=?').get(store,consumer);return row?JSON.parse(String(row.body)):null}
 private eventHead(store:string):number{return Number(this.db.prepare('SELECT head FROM store_event_heads WHERE store=?').get(store)?.head??0)}
 private writable(store:string):void{
  const row=this.db.prepare('SELECT body FROM store_catalog WHERE id=?').get(store)
  if(!row)throw storeFailure('STORE_MISSING','空间不存在，请先创建')
  if(JSON.parse(String(row.body)).archived)throw storeFailure('STORE_DENIED','空间已归档')
 }
 private object(store:string,key:string):Nullable<StoreObject>{
  const row=this.db.prepare('SELECT body FROM store_objects WHERE store=? AND key=?').get(store,key)
  return row?JSON.parse(String(row.body)):null
 }
 private consumer(store:string,consumer:string):Nullable<StoreWatch>{
  const row=this.db.prepare('SELECT body FROM store_consumers WHERE store=? AND consumer=?').get(store,consumer)
  return row?JSON.parse(String(row.body)):null
 }
 private head(store:string):number{return Number(this.db.prepare('SELECT head FROM store_heads WHERE store=?').get(store)?.head??0)}
 private committed(store:string,id:string,kind:string,fingerprint:string):Nullable<string>{
  const row=this.db.prepare('SELECT kind,fingerprint,body FROM store_commits WHERE store=? AND id=?').get(store,id)
  if(!row)return null
  if(row.kind!==kind||row.fingerprint!==fingerprint)throw storeFailure('STORE_IDENTITY','同一调用身份不能提交不同状态')
  return String(row.body)
 }
 private saveCommit(store:string,id:string,kind:string,fingerprint:string,value:unknown):void{
  this.db.prepare('INSERT INTO store_commits(store,id,kind,fingerprint,body) VALUES(?,?,?,?,?)').run(store,id,kind,fingerprint,JSON.stringify(value))
 }
 private transaction<T>(run:()=>T):T{
  this.db.exec('BEGIN IMMEDIATE')
  try{const result=run();this.db.exec('COMMIT');return result}catch(error){this.db.exec('ROLLBACK');throw error}
 }
}
