import {readFileSync} from 'node:fs'

import type {ContextRef,StoreObject,StoreValue} from '@velaros-ai/context'
import {StoreLimits} from '@velaros-ai/context'
import type {OperationDefinition,OperationModuleDefinition} from '@velaros-ai/kernel'

import {StoreModuleId,StoreProjectionLimits,StoreReadModuleId,StoreWriteModuleId,SystemContract} from '../contract/constants.js'
import type {StoreHost} from '../contract/requires.js'
import {objectSchema} from '../utils/schemas.js'

/** 多空间共享能力，唯一模型成员按实际授权生成合同。 */
export interface StoreModuleApi {
 /** 装配创建、读写或只读投影，均复用同一实现。 */
 create(host:StoreHost,mode?:'create'|'write'|'read'):OperationModuleDefinition
}
class StoreModule implements StoreModuleApi {
 public create(host:StoreHost,mode:'create'|'write'|'read'='create'):OperationModuleDefinition{
  const store={type:'string',minLength:1,maxLength:StoreLimits.scopeChars} as const
  const key={type:'string',minLength:1,maxLength:StoreLimits.keyChars} as const
  const revision={type:'integer',minimum:0} as const
  const strings={type:'array',items:{type:'string'}} as const
  const optionalPage={after:{type:'string'},limit:{type:'integer',minimum:1,maximum:StoreLimits.maxPage}} as const
  const card={key,revision,deleted:{type:'boolean'},actor:{type:'string'},sequence:revision,updatedAt:{type:'string'}} as const
  const object=objectSchema({...card,value:{}})
  const event=objectSchema({id:key,sequence:revision,topic:key,value:{},actor:{type:'string'},createdAt:{type:'string'}})
  const messages=objectSchema({revision,after:revision,through:revision,head:revision,pending:revision,events:{type:'array',items:event},gap:{type:'boolean'},hasMore:{type:'boolean'}})
  const entry=objectSchema({id:store,name:{type:'string'},description:{type:'string'},owner:{type:'string'},createdAt:{type:'string'},archived:{type:'boolean'},access:objectSchema({read:strings,write:strings})})
  const page=(items:typeof object)=>objectSchema({items:{type:'array',items},nextAfter:{anyOf:[{type:'string'},{type:'null'}]}})
  const read:OperationDefinition={summary:'按空间和键读取当前 JSON 对象及版本；未创建返回 null，删除返回墓碑',input:objectSchema({store,key}),output:{anyOf:[object,{type:'null'}]},effects:'none',
   run:(input,call)=>{const v=input as {store:string;key:string};return host.stores(call.invocation.sessionId).get(v.store,v.key)},
   reads:{capture:async(input,value)=>{const v=input as {store:string;key:string};return [{resourceId:JSON.stringify([v.store,v.key]),version:String((value as Nullable<StoreObject>)?.revision??0)}]},validate:async(stamp,call)=>stamp.version===await host.stores(call.invocation.sessionId).version(stamp.resourceId)},
  }
  const operations:Record<string,OperationDefinition>={

   list:{summary:'分页发现获配空间；active=true 只列出当前任务使用的空间引用',input:objectSchema({...optionalPage,active:{type:'boolean'}},[]),output:page(entry),effects:'none',run:(input,call)=>host.stores(call.invocation.sessionId).list(input as {after?:string;limit?:number;active?:boolean})},
   keys:{summary:'分页列出指定空间授权前缀内的对象元数据；正文用 get 获取',input:objectSchema({store,prefix:{type:'string',maxLength:StoreLimits.keyChars},...optionalPage},['store']),output:page(objectSchema(card)),effects:'none',run:(input,call)=>{const {store,...query}=input as {store:string;prefix?:string;after?:string;limit?:number};return host.stores(call.invocation.sessionId).keys(store,query)}},
   get:read,
   events:{summary:'读取订阅内逐条消息正文；默认 pending=true 只读未处理消息，窗口缺口用 gap 明确返回',input:objectSchema({store,...optionalPage,after:revision,pending:{type:'boolean'}},['store']),output:{anyOf:[messages,{type:'null'}]},effects:'none',run:(input,call)=>host.stores(call.invocation.sessionId).events(input as {store:string;after?:number;limit?:number;pending?:boolean})},
   read:{summary:'分页读取 share 发布的真实材料，不能通过任意会话引用越权读取',input:objectSchema({store,key,offset:revision,limit:{type:'integer',minimum:1,maximum:StoreProjectionLimits.maxMaterialChars}},['store','key']),output:objectSchema({text:{type:'string'},offset:revision,nextOffset:{anyOf:[revision,{type:'null'}]},chars:revision,revision}),effects:'none',reads:read.reads,run:(input,call)=>host.stores(call.invocation.sessionId).read(input as {store:string;key:string;offset?:number;limit?:number})},
   subscribe:{summary:'订阅主题前缀；省略 after 从当前消息头开始，相同声明保留进度，空 topics 取消订阅',input:objectSchema({store,topics:{type:'array',maxItems:StoreLimits.watchItems,items:{type:'string',maxLength:StoreLimits.keyChars}},after:revision},['store','topics']),output:objectSchema({revision,start:revision,after:revision,topics:strings}),effects:'write',allowedModes:['execute'],run:(input,call)=>host.stores(call.invocation.sessionId).subscribe(input as {store:string;topics:string[];after?:number},call.invocation.id)},
   ack:{summary:'业务处理完成后逐条确认消息；已投递不等于已处理，身份必须在当前订阅权限内',input:objectSchema({store,ids:{type:'array',minItems:1,maxItems:StoreLimits.maxPage,items:key}}),output:objectSchema({ids:strings}),effects:'write',allowedModes:['execute'],run:(input,call)=>host.stores(call.invocation.sessionId).ack(input as {store:string;ids:string[]},call.invocation.id)},
   ...(mode!=='read'?{
    publish:{summary:'发布独立消息，保留每次调用；主题按空间写前缀授权，正文最多 16 KiB',input:objectSchema({store,topic:key,value:{}}),output:event,effects:'write' as const,allowedModes:['execute' as const],run:(input,call)=>host.stores(call.invocation.sessionId).publish(input as {store:string;topic:string;value:StoreValue},call.invocation.id)} satisfies OperationDefinition,
    share:{summary:'把本会话原文复制为键绑定的共享材料；接收者用 read 分页读取，不获得源会话访问权',input:objectSchema({store,key,baseRevision:revision,ref:objectSchema({sessionId:store,id:key})}),output:object,effects:'write' as const,allowedModes:['execute' as const],reads:read.reads,run:(input,call)=>host.stores(call.invocation.sessionId).share(input as {store:string;key:string;baseRevision:number;ref:ContextRef},call.invocation.id)} satisfies OperationDefinition,
    set:{summary:'按 baseRevision 创建或完整替换对象；冲突后重读，0 只用于新键；event 可与对象同一事务发布',input:objectSchema({store,key,baseRevision:revision,value:{},event:objectSchema({topic:key,value:{}})},['store','key','baseRevision','value']),output:object,effects:'write' as const,reads:read.reads,allowedModes:['execute' as const],run:(input,call)=>host.stores(call.invocation.sessionId).set(input as {store:string;key:string;baseRevision:number;value:StoreValue;event?:{topic:string;value:StoreValue}},call.invocation.id)} satisfies OperationDefinition,
    remove:{summary:'按版本删除对象，保留墓碑；对象删除不影响空间本身',input:objectSchema({store,key,baseRevision:revision}),output:object,effects:'write' as const,reads:read.reads,allowedModes:['execute' as const],run:(input,call)=>host.stores(call.invocation.sessionId).remove(input as {store:string;key:string;baseRevision:number},call.invocation.id)} satisfies OperationDefinition,
   }:{}),
   watch:{summary:'替换指定空间的持久关注集合；空集合取消，相同声明不重置进度；先 watch 再读取基线',input:objectSchema({store,keys:{type:'array',maxItems:StoreLimits.watchItems,items:key},prefixes:{type:'array',maxItems:StoreLimits.watchItems,items:{type:'string',maxLength:StoreLimits.keyChars}}},['store']),output:objectSchema({revision,after:revision,keys:strings,prefixes:strings}),effects:'write',allowedModes:['execute'],run:(input,call)=>host.stores(call.invocation.sessionId).watch(input as {store:string;keys?:string[];prefixes?:string[]},call.invocation.id)},
  }
  if(mode==='create')operations.create={summary:'创建独立持久空间，返回稳定 id；名称不是授权，重启后通过 list 发现',input:objectSchema({name:{type:'string',minLength:1,maxLength:StoreLimits.nameChars},description:{type:'string',maxLength:StoreLimits.descriptionChars}},['name']),output:entry,effects:'write' as const,allowedModes:['execute' as const],run:(input,call)=>host.stores(call.invocation.sessionId).create(input as {name:string;description?:string},call.invocation.id)}
  const moduleId=mode==='create'?StoreModuleId:mode==='write'?StoreWriteModuleId:StoreReadModuleId
  return {binding:{moduleId,instanceId:'standard:store',generation:SystemContract.generation,schemaRevision:`${SystemContract.schemaRevision}:${mode}`},summary:'独立持久空间、结构化对象、显式共享与恢复通知',template:readFileSync(new URL(mode==='create'?'../store-template.js':mode==='write'?'../store-write-template.js':'../store-read-template.js',import.meta.url),'utf8').trim(),operations:Object.fromEntries(Object.entries(operations).map(([name,operation])=>[name,{...operation,
   reconcile: operation.effects==='write' ? async(invocation,signal)=>{signal.throwIfAborted();return await host.stores(invocation.sessionId).committed(invocation.id,(invocation.input as {store?:string}).store)?{outcome:'succeeded' as const,effect:'committed' as const,evidence:'空间事务回执已持久化'}:null} : undefined,
   run:async(input,call)=>{try{const value=await operation.run(input,call);call.recordEffect(operation.effects==='write'?'committed':'none');return value}catch(error){if((error as {effect?:string}).effect==='none')call.recordEffect('none');throw error}},
  }]))}
 }
}
/** 唯一 store 能力的装配实例。 */
export const storeModule:StoreModuleApi=new StoreModule()
