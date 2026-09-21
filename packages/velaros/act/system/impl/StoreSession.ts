import {createHash} from 'node:crypto'

import type {ContextRef,ContextStorage,StoreChanges,StoreDescriptor,StoreEvent,StoreEventAck,StoreEventPage,StoreObject,StorePage,StorePublish,StoreStorage,StoreSubscription,StoreValue,StoreWatch} from '@velaros-ai/context'
import {createContextRuntime,StoreLimits} from '@velaros-ai/context'
import {isFalse,isNull,toNullable,toOptional} from '@velaros-ai/core'
import { isArray, isEmpty, isString } from '@velaros-ai/core'

import {StoreProjectionLimits} from '../contract/constants.js'
import type {StoreConfiguration,StoreEntry,StoreFrame,StoreGrant} from '../types/store.js'
import {assertStoreKey,storeDenied} from '../utils/store.js'

/** 按会话授权的多空间访问端口。 */
export interface StoreSessionApi {
 /** 打开会话时固定的宿主配置。 */
 readonly configuration:StoreConfiguration
 /** 宿主边界。 */
 readonly scope:string
 /** 实际可用的合同投影。 */
 readonly mode:'create'|'write'|'read'
 /** 核验已有目录与授权，确定实际合同投影。 */
 initialize():Promise<void>
 /** 创建会话拥有的独立空间。 */
 create(input:{name:string;description?:string},operationId:string):Promise<StoreEntry>
 /** 分页发现当前可访问空间。 */
 list(query:{after?:string;limit?:number;active?:boolean}):Promise<{items:readonly StoreEntry[];nextAfter:Nullable<string>}>
 /** 读取真实对象。 */
 get(store:string,key:string):Promise<Nullable<StoreObject>>
 /** 按权限分页读取对象目录。 */
 keys(store:string,query:{prefix?:string;after?:string;limit?:number}):Promise<StorePage>
 /** 按版本替换 JSON 对象。 */
 set(input:{store:string;key:string;baseRevision:number;value:StoreValue;event?:{topic:string;value:StoreValue}},operationId:string):Promise<StoreObject>
 /** 保留版本的删除。 */
 remove(input:{store:string;key:string;baseRevision:number},operationId:string):Promise<StoreObject>
 /** 替换指定空间的持久关注集合。 */
 watch(input:{store:string;keys?:readonly string[];prefixes?:readonly string[]},operationId:string):Promise<StoreWatch>
 /** 发布独立消息，主题使用空间写前缀授权。 */
 publish(input:Omit<StorePublish,'actor'|'operationId'>,operationId:string):Promise<StoreEvent>
 /** 订阅主题前缀，省略游标从当前消息头开始。 */
 subscribe(input:{store:string;topics:readonly string[];after?:number},operationId:string):Promise<StoreSubscription>
 /** 读取订阅正文，默认只读尚未处理的消息。 */
 events(input:{store:string;after?:number;limit?:number;pending?:boolean}):Promise<Nullable<StoreEventPage>>
 /** 精确确认业务已经处理的消息。 */
 ack(input:{store:string;ids:readonly string[]},operationId:string):Promise<StoreEventAck>
 /** 把本会话原文复制到键绑定的不可变材料空间。 */
 share(input:{store:string;key:string;baseRevision:number;ref:ContextRef},operationId:string):Promise<StoreObject>
 /** 按键权限分页读取真实共享材料，不解析任意跨会话引用。 */
 read(input:{store:string;key:string;offset?:number;limit?:number}):Promise<{text:string;offset:number;nextOffset:Nullable<number>;chars:number;revision:number}>
 /** 在总额度内构建目录与公平分配的变化页。 */
 frame(limit:number,activeChars?:number):Promise<StoreFrame>
 /** 仅确认真实接受帧的各空间位置。 */
 acknowledge(frame:StoreFrame):Promise<void>
 /** 判断是否需要投递新变化。 */
 pending():Promise<boolean>
 /** 等待任一获配空间的相关变化。 */
 wait(signal:AbortSignal):Promise<void>
 /** 校验带空间身份的真实对象版本。 */
 version(resourceId:string):Promise<string>
 /** 根据调用身份核对真实提交。 */
 committed(operationId:string,store?:string):Promise<boolean>
 /** 验证子任务申请为当前授权子集，返回独立数据副本。 */
 delegate(grants:readonly StoreGrant[]):Promise<readonly StoreGrant[]>
}
export class StoreSession implements StoreSessionApi {
 public readonly scope:string
 public mode:'create'|'write'|'read'
 private readonly storage:StoreStorage
 private readonly grants=new Map<string,StoreGrant>()
 private rotation=''
 public readonly configuration:StoreConfiguration
 public constructor(private readonly id:string,private readonly context:ContextStorage,configuration:StoreConfiguration,private readonly owned=true){
  if(!context.stores)throw new Error('当前存储没有 store 端口')
  this.storage=context.stores
  this.configuration=Object.freeze(structuredClone(configuration));this.scope=configuration.scope
  if(!this.scope?.trim()||this.scope.length>StoreLimits.scopeChars||this.scope.includes('\0'))throw storeDenied('存储边界无效')
  if((configuration.grants?.length??0)>StoreLimits.stores)throw storeDenied('授权空间数量过多')
  for(const grant of configuration.grants??[]){
   if(!grant.store?.trim()||grant.store.length>StoreLimits.scopeChars||this.grants.has(grant.store))throw storeDenied('空间授权标识无效或重复')
   for(const items of [grant.read,grant.write])if(!isArray(items)||items.length>StoreLimits.watchItems||items.some(prefix=>!isString(prefix)||prefix.length>StoreLimits.keyChars||prefix.includes('\0')))throw storeDenied('空间授权前缀无效')
   if(grant.write.some(prefix=>!grant.read.some(read=>prefix.startsWith(read))))throw storeDenied('写入范围超出读取范围')
   this.grants.set(grant.store,{store:grant.store,read:[...new Set(grant.read)].sort(),write:[...new Set(grant.write)].sort()})
  }
  this.mode=!isFalse(configuration.create)?'create':[...this.grants.values()].some(g=>g.write.length)?'write':'read'
 }
 public async initialize():Promise<void>{
  if(this.owned){
   let after:Optional<string>
   while(this.mode==='read'){
    const page=await this.storage.directory(this.scope,this.id,[],after,StoreLimits.maxPage)
    if(page.items.some(item=>!this.grants.has(item.id)||this.grants.get(item.id)!.write.length))this.mode='write'
    if(!page.nextAfter)break
    after=page.nextAfter
   }
  }
  for(const id of this.grants.keys())await this.access(id)
 }
 public async create(input:{name:string;description?:string},operationId:string):Promise<StoreEntry>{
  if(this.mode!=='create')throw storeDenied('当前会话没有创建空间的能力')
  const descriptor=await this.storage.create({...input,scope:this.scope,owner:this.id,operationId})
  await this.remember([descriptor.id])
  return {...descriptor,access:{read:[''],write:['']}}
 }
 public async list(query:{after?:string;limit?:number;active?:boolean}):Promise<{items:readonly StoreEntry[];nextAfter:Nullable<string>}>{
  if(query.active){
   const limit=query.limit??StoreLimits.page
   if(!Number.isSafeInteger(limit)||limit<1||limit>StoreLimits.maxPage)throw storeDenied('空间目录分页范围无效')
   const entries=(await this.active()).entries.filter(item=>item.id>(query.after??'')).sort((a,b)=>a.id<b.id?-1:1)
   const items=entries.slice(0,limit)
   return {items,nextAfter:entries.length>limit?items.at(-1)!.id:null}
  }
  const page=await this.storage.directory(this.scope,this.owned?this.id:'', [...this.grants.keys()],query.after,query.limit)
  return {...page,items:page.items.map(item=>({...item,access:this.rights(item)}))}
 }
 public async get(store:string,key:string):Promise<Nullable<StoreObject>>{const access=await this.access(store);assertStoreKey(access,key,false);await this.remember([store]);return this.storage.get(store,key)}
 public async keys(store:string,query:{prefix?:string;after?:string;limit?:number}):Promise<StorePage>{const access=await this.access(store);await this.remember([store]);return this.storage.list(store,{...query,read:access.read})}
 public async set(input:{store:string;key:string;baseRevision:number;value:StoreValue;event?:{topic:string;value:StoreValue}},operationId:string):Promise<StoreObject>{
  const access=await this.access(input.store);assertStoreKey(access,input.key,true);if(input.event)assertStoreKey(access,input.event.topic,true);await this.remember([input.store]);return this.storage.commit({...input,actor:this.id,operationId})
 }
 public async remove(input:{store:string;key:string;baseRevision:number},operationId:string):Promise<StoreObject>{
  assertStoreKey(await this.access(input.store),input.key,true);await this.remember([input.store]);return this.storage.commit({...input,remove:true,actor:this.id,operationId})
 }
 public async watch(input:{store:string;keys?:readonly string[];prefixes?:readonly string[]},operationId:string):Promise<StoreWatch>{
  const access=await this.access(input.store)
  for(const key of input.keys??[])assertStoreKey(access,key,false)
  for(const prefix of input.prefixes??[])if(!access.read.some(read=>prefix.startsWith(read)))throw storeDenied('关注范围超出读取权限')
  await this.remember([input.store])
  return this.storage.watch(input.store,this.consumer(access),input.keys??[],input.prefixes??[],operationId)
 }
 public async publish(input:Omit<StorePublish,'actor'|'operationId'>,operationId:string):Promise<StoreEvent>{
  assertStoreKey(await this.access(input.store),input.topic,true);await this.remember([input.store])
  return this.storage.publish({...input,actor:this.id,operationId})
 }
 public async subscribe(input:{store:string;topics:readonly string[];after?:number},operationId:string):Promise<StoreSubscription>{
  const access=await this.access(input.store)
  for(const prefix of input.topics)if(!access.read.some(read=>prefix.startsWith(read)))throw storeDenied('消息订阅范围超出读取权限')
  await this.remember([input.store]);return this.storage.subscribe(input.store,this.consumer(access),input.topics,operationId,input.after)
 }
 public async events(input:{store:string;after?:number;limit?:number;pending?:boolean}):Promise<Nullable<StoreEventPage>>{
  const access=await this.access(input.store);await this.remember([input.store])
  return this.storage.messages(input.store,this.consumer(access),access.read,input)
 }
 public async ack(input:{store:string;ids:readonly string[]},operationId:string):Promise<StoreEventAck>{
  const access=await this.access(input.store);await this.remember([input.store])
  return this.storage.acknowledgeEvents(input.store,this.consumer(access),access.read,input.ids,operationId)
 }
 public async share(input:{store:string;key:string;baseRevision:number;ref:ContextRef},operationId:string):Promise<StoreObject>{
  assertStoreKey(await this.access(input.store),input.key,true)
  if(input.ref.sessionId!==this.id)throw storeDenied('只能共享当前会话已授权的原文')
  const record=(await this.context.load(this.id))?.records.find(item=>item.ref.id===input.ref.id)
  if(!record)throw storeDenied('共享原文引用不存在')
  const text=await this.context.get(this.id,record.objectId)
  if(isNull(text))throw storeDenied('共享原文已经缺失')
  const namespace=this.materialScope(input.store,input.key)
  const copied=await createContextRuntime({sessionId:namespace,storage:this.context}).append({kind:'note',title:`material:${record.objectId}`,body:text})
  const objectId=copied.objectId
  return this.set({store:input.store,key:input.key,baseRevision:input.baseRevision,value:{kind:'store.material',objectId,chars:text.length,source:{...input.ref}}},operationId)
 }
 public async read(input:{store:string;key:string;offset?:number;limit?:number}):Promise<{text:string;offset:number;nextOffset:Nullable<number>;chars:number;revision:number}>{
  const object=await this.get(input.store,input.key); const value=object?.value as Optional<{kind?:string;objectId?:string}>
  if(!object||object.deleted||value?.kind!=='store.material'||!isString(value.objectId))throw storeDenied('对象不是共享材料')
  const offset=input.offset??0; const limit=input.limit??StoreProjectionLimits.materialChars
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>StoreProjectionLimits.maxMaterialChars)throw storeDenied('材料分页无效')
  const body=await this.context.get(this.materialScope(input.store,input.key),value.objectId)
  if(isNull(body))throw storeDenied('材料正文不存在，不能凭引用重建')
  return {text:body.slice(offset,offset+limit),offset,nextOffset:offset+limit<body.length?offset+limit:null,chars:body.length,revision:object.revision}
 }
 private materialScope(store:string,key:string):string{return `store-material:${createHash('sha256').update(JSON.stringify([this.scope,store,key])).digest('hex')}`}
 public async frame(limit:number,activeChars:number=StoreProjectionLimits.activeChars):Promise<StoreFrame>{
  const task=(await this.context.load(this.id))?.task
  await this.remember([...this.grants.keys()].filter(id=>!task?.releasedStoreRefs?.includes(id)))
  const entries=await this.all(); const changes:Array<StoreFrame['changes'][number]>=[]; const messages:Array<StoreFrame['messages'][number]>=[]
  const ordered=[...entries.filter(x=>x.id>this.rotation),...entries.filter(x=>x.id<=this.rotation)]
  // 每空间每帧至多一个合并事件，所有空间合计不超过预算；确认后轮换起点。
  for(const entry of ordered){
   if(changes.length+messages.length>=limit)break
   const delivery=await this.messages({store:entry.id,...entry.access},1)
   if(delivery&&(delivery.events.length||delivery.gap))messages.push({store:entry.id,...delivery,events:delivery.events.map(({value:_value,...card})=>card)})
   if(changes.length+messages.length>=limit)break
   const change=await this.changes({store:entry.id,...entry.access},1)
   if(change&&(change.events.length||change.gap))changes.push({store:entry.id,...change})
   if(changes.length+messages.length<limit&&delivery?.pending&&isEmpty(delivery.events)&&!delivery.gap)messages.push({store:entry.id,...delivery,events:[]})
  }
  const page=await this.list({limit:StoreProjectionLimits.directory})
  const active=await this.active(entries); const items:Array<StoreFrame['active']['items'][number]>=[]
  let chars=2
  for(const entry of active.entries){
   const item={id:entry.id,name:entry.name,description:entry.description.slice(0,StoreProjectionLimits.descriptionChars),descriptionTruncated:entry.description.length>StoreProjectionLimits.descriptionChars}
   const size=JSON.stringify(item).length+(!isEmpty(items)?1:0)
   if(chars+size>activeChars)continue
   items.push(item);chars+=size
  }
  return {...page,changes,messages,active:{taskId:active.taskId,items,total:active.entries.length,omitted:active.entries.length-items.length}}
 }
 public async acknowledge(frame:StoreFrame):Promise<void>{
  for(const message of frame.messages){
   const access=await this.access(message.store)
   await this.storage.delivered(message.store,this.consumer(access),message.revision,message.through);this.rotation=message.store
  }
  for(const change of frame.changes){
   // 权限撤回后旧帧不能再推进新的消费者。
   const access=await this.access(change.store)
   await this.storage.acknowledge(change.store,this.consumer(access),change.revision,change.through)
   this.rotation=change.store
  }
 }
 public async pending():Promise<boolean>{
  for(const entry of await this.all()){
   const access={store:entry.id,...entry.access}; const change=await this.changes(access,1); const message=await this.messages(access,1)
   if(change&&(change.gap||change.events.length)||message&&(message.gap||message.events.length))return true
  }
  return false
 }
 public async wait(signal:AbortSignal):Promise<void>{
  while(true){
   signal.throwIfAborted();const waits:Array<{store:string;head:number;messages?:boolean}>=[]
   for(const entry of await this.all()){
    const change=await this.changes({store:entry.id,...entry.access},1)
    if(change&&(change.gap||change.events.length))return
    if(change)waits.push({store:entry.id,head:change.head})
    const message=await this.messages({store:entry.id,...entry.access},1)
    if(message&&(message.gap||message.events.length))return
    if(message)waits.push({store:entry.id,head:message.head,messages:true})
   }
   const controller=new AbortController(); const combined=AbortSignal.any([signal,controller.signal])
   try{
    if(!isEmpty(waits))await Promise.race(waits.map(item=>item.messages?this.storage.waitEvents(item.store,item.head,combined):this.storage.wait(item.store,item.head,combined)))
    else await new Promise<void>((_resolve,reject)=>{const abort=()=>reject(combined.reason);combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort()})
   }finally{controller.abort()}
  }
 }
 public async version(resourceId:string):Promise<string>{const [store,key]=JSON.parse(resourceId) as [string,string];return String((await this.get(store,key))?.revision??0)}
 public async committed(operationId:string,store?:string):Promise<boolean>{
  if(store){await this.access(store);const receipt=await this.storage.receipt(store,operationId);if(receipt)await this.remember([store]);return Boolean(receipt)}
  const receipt=await this.storage.creation(this.scope,this.id,operationId)
  if(receipt)await this.remember([receipt.id])
  return Boolean(receipt)
 }
 public async delegate(grants:readonly StoreGrant[]):Promise<readonly StoreGrant[]>{
  if(grants.length>StoreLimits.stores||new Set(grants.map(g=>g.store)).size!==grants.length)throw storeDenied('共享空间数量或身份无效')
  for(const grant of grants){
   const current=await this.access(grant.store)
   for(const mode of ['read','write'] as const)if(grant[mode].some(prefix=>!current[mode].some(parent=>prefix.startsWith(parent))))throw storeDenied('共享范围超出父会话权限')
  }
  await this.remember(grants.map(grant=>grant.store))
  return structuredClone(grants)
 }
 private async active(entries?:readonly StoreEntry[]):Promise<{taskId:Nullable<string>;entries:StoreEntry[]}>{
  const task=(await this.context.load(this.id))?.task
  const available=new Map((entries??await this.all()).map(entry=>[entry.id,entry]))
  const ids=[...new Set([...(task?.storeRefs??[]),...this.grants.keys()])].filter(id=>!task?.releasedStoreRefs?.includes(id))
  return {taskId:toNullable(task?.id),entries:ids.flatMap(id=>available.has(id)?[available.get(id)!]:[])}
 }
 private async remember(ids:readonly string[]):Promise<void>{
  if(isEmpty(ids))return
  const initial=await this.context.load(this.id); const taskId=initial?.task?.id
  if(!taskId)return
  if(ids.every(id=>initial.task!.storeRefs?.includes(id)&&!initial.task!.releasedStoreRefs?.includes(id)))return
  const accessible=new Set((await this.all()).map(entry=>entry.id))
  for(let attempt=0;attempt<64;attempt++){
   const snapshot=attempt?await this.context.load(this.id):initial
   if(!snapshot?.task||snapshot.task.id!==taskId)return
   const refs=[...new Set([...ids,...snapshot.task.storeRefs??[]])].filter(id=>accessible.has(id))
   if(JSON.stringify(refs)===JSON.stringify(snapshot.task.storeRefs??[]))return
   // 只更新任务附属引用，不改变执行租约、决策版本或用户正文。
   if(await this.context.compareAndSwap(this.id,snapshot.version,{...snapshot,version:snapshot.version+1,task:{...snapshot.task,storeRefs:refs,releasedStoreRefs:snapshot.task.releasedStoreRefs?.filter(id=>!ids.includes(id))}}))return
  }
  throw new Error('任务 store 引用并发更新失败')
 }
 private async all():Promise<StoreEntry[]>{
  const entries:StoreEntry[]=[];let after:Optional<string>
  do{const page=await this.list({after,limit:StoreLimits.maxPage});entries.push(...page.items);after=toOptional(page.nextAfter)}while(after)
  return entries
 }
 private async messages(access:StoreGrant,limit:number):Promise<Nullable<StoreEventPage>>{
  const consumer=this.consumer(access); const page=await this.storage.messages(access.store,consumer,access.read,{limit,delivery:true})
  if(page&&isEmpty(page.events)&&!page.gap&&page.through>page.after)await this.storage.delivered(access.store,consumer,page.revision,page.through)
  return page
 }
 private async changes(access:StoreGrant,limit:number):Promise<Nullable<StoreChanges>>{
  const consumer=this.consumer(access)
  let change=await this.storage.changes(access.store,consumer,access.read,limit)
  for(let i=0;change&&isEmpty(change.events)&&!change.gap&&change.through>change.after&&i<StoreLimits.retainedEvents/StoreLimits.scanEvents;i++){
   await this.storage.acknowledge(access.store,consumer,change.revision,change.through)
   change=await this.storage.changes(access.store,consumer,access.read,limit)
  }
  return change
 }
 private consumer(access:StoreGrant):string{return `${this.id}:${createHash('sha256').update(JSON.stringify(access)).digest('hex')}`}
 private rights(store:StoreDescriptor):{read:readonly string[];write:readonly string[]}{const grant=this.grants.get(store.id);if(grant)return {read:grant.read,write:grant.write};return this.owned&&store.owner===this.id?{read:[''],write:this.mode==='read'?[]:['']}:{read:[],write:[]}}
 private async access(id:string):Promise<StoreGrant>{
  const store=await this.storage.describe(this.scope,id)
  if(!store||store.archived||!(this.owned&&store.owner===this.id)&&!this.grants.has(id))throw storeDenied('空间不存在或未授权')
  return {store:id,...this.rights(store)}
 }
}
