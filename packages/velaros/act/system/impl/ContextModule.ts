import {readFileSync} from 'node:fs'

import type {ContextRef} from '@velaros-ai/context'
import type {OperationModuleDefinition} from '@velaros-ai/kernel'

import {ContextMaterialsModuleId,SystemContract} from '../contract/constants.js'
import type {ContextMaintenanceHost} from '../contract/requires.js'
import {contextContentSchema,contextRecordSchema,objectSchema} from '../utils/schemas.js'

/** 整理会话的只读父快照能力。 */
export interface ContextModuleApi {
 /** 只生成固定快照的 list/read 合同。 */
 create(host:ContextMaintenanceHost):readonly OperationModuleDefinition[]
}
class ContextModule implements ContextModuleApi {
 public create(host:ContextMaintenanceHost):readonly OperationModuleDefinition[]{
  const binding=(moduleId:string)=>({moduleId,instanceId:`standard:${moduleId}`,generation:SystemContract.generation,schemaRevision:SystemContract.schemaRevision})
  return [{binding:binding(ContextMaterialsModuleId),summary:'读取当前整理任务的固定父快照，返回原文引用与分页',template:readFileSync(new URL('../context-materials-template.js',import.meta.url),'utf8').trim(),operations:{
   list:{summary:'列举快照材料的元数据，不隐式读取正文',input:objectSchema({after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:64}},[]),output:objectSchema({items:{type:'array',items:contextRecordSchema},nextAfter:{anyOf:[{type:'integer'},{type:'null'}]}}),effects:'none',allowedModes:['execute'],run:(input,call)=>host.materials(call.invocation.sessionId,input as {after?:number;limit?:number},call.signal)},
   read:{summary:'按快照中的引用读取父会话原文页',input:objectSchema({ref:objectSchema({sessionId:{type:'string'},id:{type:'string'}}),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:32000}},['ref']),output:contextContentSchema,effects:'none',allowedModes:['execute'],run:(input,call)=>host.materials(call.invocation.sessionId,input as {ref:ContextRef;offset?:number;limit?:number},call.signal)},
  }}]
 }
}
/** 工具入口与资料读取共享当前整理服务。 */
export const contextModule:ContextModuleApi=new ContextModule()
