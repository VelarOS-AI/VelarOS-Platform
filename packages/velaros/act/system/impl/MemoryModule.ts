import {readFileSync} from 'node:fs'

import type {ContextRef,TaskCapsule} from '@velaros-ai/context'
import {TaskCapsuleSchema} from '@velaros-ai/context'
import type {OperationModuleDefinition} from '@velaros-ai/kernel'

import {VelarMemoryModule} from '../../../memory/contract/surface.js'
import {memoryOperations} from '../../../memory/impl/MemoryOperations.js'
import type {MemoryIdInput,MemorySaveInput} from '../../../memory/types/memory.js'
import {LocalMemoryModuleId,MemoryModuleId,MemoryRecallLimits,PersistentMemoryModuleId,ScriptLeaseLimits,SystemContract,WorkspaceLimits} from '../contract/constants.js'
import type {MemoryHost} from '../contract/requires.js'
import type {MemoryOrganizeIntent,MemoryQuery} from '../types/memory.js'
import type {ScriptRetention} from '../types/results.js'
import type {WorkspaceUpdate} from '../types/workspace.js'
import {contextContentSchema,contextRecordSchema,contextRefSchema,objectSchema} from '../utils/schemas.js'

/** 同一记忆实现根据装配生成可委托整理或本地操作合同。 */
export interface MemoryModuleApi {
 /** organize 控制整理委托，persistent 仅用于主线已装配长期记忆的合同。 */
 create(host:MemoryHost,organize?:boolean,persistent?:boolean):OperationModuleDefinition
}
class MemoryModule implements MemoryModuleApi {
 public create(host:MemoryHost,organize=true,persistent=false):OperationModuleDefinition{
  const ref={anyOf:[{type:'string',minLength:1,maxLength:128},contextRefSchema]} as const
  const moduleId=persistent?PersistentMemoryModuleId:organize?MemoryModuleId:LocalMemoryModuleId
  if(persistent&&!host.longTermMemory)throw new Error('长期记忆合同需要宿主作用域端口')
  const query=objectSchema({kind:{enum:['all','notes','inputs','programs','results','history','artifacts']},query:{type:'string',maxLength:200},after:{type:'integer',minimum:0},through:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:64}},[])
  const note={key:{type:'string'},revision:{type:'integer'},title:{type:'string'},ref:contextRefSchema,resident:{type:'boolean'},chars:{type:'integer'}} as const
  const entry=objectSchema({...contextRecordSchema.properties,...note},contextRecordSchema.required)
  const definition:OperationModuleDefinition={binding:{moduleId,instanceId:`standard:${moduleId}`,generation:SystemContract.generation,schemaRevision:persistent?`${SystemContract.schemaRevision}:${organize?'organize':'local'}`:SystemContract.schemaRevision},summary:persistent?'任务工作记忆与跨会话长期记忆':'当前任务的原文召回、工作笔记与材料驻留',template:readFileSync(new URL(organize?'../memory-template.js':'../memory-local-template.js',import.meta.url),'utf8').trim()+(persistent?`\n${readFileSync(new URL('../memory-long-term-template.js',import.meta.url),'utf8').trim()}`:''),operations:{
   ...(persistent?{
    recall:{summary:'分页召回宿主作用域中的长期记忆，含正文；id 精确读取，query 按标题、描述、标签和正文匹配；历史记忆使用前应核实',input:objectSchema({id:{type:'string',minLength:1,maxLength:64},query:{type:'string',maxLength:200},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:MemoryRecallLimits.maxPage}},[]),output:{...objectSchema({items:{$ref:VelarMemoryModule.operations.list.output.$ref},total:{type:'integer'},nextOffset:{anyOf:[{type:'integer'},{type:'null'}]}}),definitions:VelarMemoryModule.operations.list.output.definitions},effects:'none' as const,run:async(input:unknown,call:Parameters<OperationModuleDefinition['operations'][string]['run']>[1])=>{
     const value=input as {id?:string;query?:string;offset?:number;limit?:number}
     const entries=await memoryOperations.list({memory:host.longTermMemory!.scope(call.invocation.sessionId),abortSignal:call.signal})
     call.signal.throwIfAborted()
     const query=value.query?.trim().toLowerCase()
     const selected=entries.filter(entry=>(!value.id||entry.id===value.id)&&(!query||[entry.id,entry.title,entry.description,...entry.tags,entry.content].join(' ').toLowerCase().includes(query)))
     const offset=value.offset??0; const limit=value.limit??MemoryRecallLimits.page
     return {items:selected.slice(offset,offset+limit),total:selected.length,nextOffset:offset+limit<selected.length?offset+limit:null}
    }},
    save:{summary:'将值得跨会话保存的用户偏好、反馈、工作决定或资源位置写入长期记忆；同 id 整条覆盖，tags 省略沿用；只在 execute 中调用',input:VelarMemoryModule.operations.save.input,output:VelarMemoryModule.operations.save.output,effects:'write' as const,allowedModes:['execute'] as const,run:(input:unknown,call:Parameters<OperationModuleDefinition['operations'][string]['run']>[1])=>memoryOperations.save(input as MemorySaveInput,{memory:host.longTermMemory!.scope(call.invocation.sessionId),abortSignal:call.signal})},
    remove:{summary:'显式删除一条长期记忆；与 release 当前任务驻留不同，本操作删除磁盘原文',input:VelarMemoryModule.operations.remove.input,output:VelarMemoryModule.operations.remove.output,effects:'write' as const,allowedModes:['execute'] as const,run:(input:unknown,call:Parameters<OperationModuleDefinition['operations'][string]['run']>[1])=>memoryOperations.remove(input as MemoryIdInput,{memory:host.longTermMemory!.scope(call.invocation.sessionId),abortSignal:call.signal})}
   }:{}),
   list:{summary:'按种类和标题分页查找当前任务材料；只返回引用、位置、大小和笔记版本',input:query,output:objectSchema({items:{type:'array',items:entry},nextAfter:{anyOf:[{type:'integer'},{type:'null'}]}}),effects:'none',run:(input,call)=>host.programs(call.invocation.sessionId).memory.catalog(input as MemoryQuery,call.signal)},
   read:{summary:'统一分页读取输入、源码、结果、笔记和材料原文；读取不续租、不执行脚本',input:objectSchema({ref,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:60000}},['ref']),output:contextContentSchema,effects:'none',run:(input,call)=>{const value=input as {ref:ContextRef|string;offset?:number;limit?:number};return host.programs(call.invocation.sessionId).memory.readMaterial(value.ref,value.offset,value.limit,call.signal)}},
   update:{summary:'维护自己的笔记或计划；笔记用 key/baseRevision，计划用 plan；只在 execute 中调用',input:{anyOf:[objectSchema({key:{type:'string',minLength:1,maxLength:96},baseRevision:{type:'integer',minimum:0},title:{type:'string',maxLength:200},body:{type:'string',maxLength:60000},sources:{type:'array',maxItems:WorkspaceLimits.sources,items:contextRefSchema},resident:{type:'boolean'}},['key','baseRevision']),objectSchema({plan:TaskCapsuleSchema})]},output:objectSchema({...note,...TaskCapsuleSchema.properties},[]),effects:'write',allowedModes:['execute'],run:(input,call)=>'plan' in (input as object)?host.view(call.invocation.sessionId).updateCapsule((input as {plan:Partial<TaskCapsule>}).plan,call.signal,call.invocation.executionId):host.programs(call.invocation.sessionId).memory.update(input as WorkspaceUpdate,call.signal)},
   retain:{summary:'保留当前笔记或执行结果；结果 turns 为成功业务回合数或 task，笔记驻留到主动释放；不重跑脚本',input:objectSchema({ref,turns:{anyOf:[{type:'integer',minimum:1,maximum:ScriptLeaseLimits.maxTurns},{const:'task'}]}},['ref']),output:{type:'object'},effects:'write',allowedModes:['execute'],run:(input,call)=>{const value=input as {ref:ContextRef|string;turns?:ScriptRetention};return host.programs(call.invocation.sessionId).memory.retainMaterial(value.ref,value.turns??'task',call.signal)}},
   release:{summary:'释放笔记或执行结果的自动展示，原文仍可召回',input:objectSchema({ref}),output:{type:'object'},effects:'write',allowedModes:['execute'],run:(input,call)=>host.programs(call.invocation.sessionId).memory.retainMaterial((input as {ref:ContextRef|string}).ref,null,call.signal)},

  }}
  if(organize)Object.assign(definition.operations,{organize:{summary:'声明下一阶段 focus 和需保留引用 preserve，安排下一请求前整理；返回 scheduled 和 requestId，实际结果自动进入下一帧',input:objectSchema({focus:{type:'string',minLength:1,maxLength:3000},preserve:{type:'array',maxItems:WorkspaceLimits.sources,items:contextRefSchema}},[]),output:objectSchema({requestId:{type:'string'},taskId:{type:'string'},status:{const:'scheduled'},focus:{type:'string'},preserve:{type:'array',items:contextRefSchema},boundary:{const:'next-model-request'}}),effects:'write' as const,allowedModes:['execute'] as const,run:(input:unknown,call:Parameters<NonNullable<OperationModuleDefinition['operations'][string]['run']>>[1])=>{if(!host.maintenance)throw new Error('当前会话没有整理服务');return host.maintenance.request(call.invocation.sessionId,input as MemoryOrganizeIntent,call.signal)}}})
  // 这些错误发生在校验或 CAS 成功之前，准确记录没有管理状态写入。
  return {...definition,operations:Object.fromEntries(Object.entries(definition.operations).map(([name,operation])=>[name,{...operation,run:async(input,call)=>{try{return await operation.run(input,call)}catch(error){if(['VALIDATION','MEMORY_INPUT','SCOPE_MISMATCH','WORKSPACE_CONFLICT','WORKSPACE_LIMIT','WORKSPACE_BUSY','CONTEXT_CONFLICT','MEMORY_REFERENCE_KIND'].includes((error as {code?:string}).code??''))call.recordEffect('none');throw error}}}]))}

 }
}
/** 同一存储与 Kernel 上的记忆装配。 */
export const memoryModule:MemoryModuleApi=new MemoryModule()
