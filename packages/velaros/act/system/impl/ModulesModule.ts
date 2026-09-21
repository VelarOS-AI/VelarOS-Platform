import { readFileSync } from 'node:fs'

import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { ModulesModuleId, SystemContract } from '../contract/constants.js'
import type { ModulesHost } from '../contract/requires.js'
import type { SystemModuleQuery } from '../types/modules.js'
import { moduleDescriptionSchema, modulePageSchema, objectSchema, querySchema } from '../utils/schemas.js'

import { SystemCatalog } from './SystemCatalog.js'

/** 查询当前授权包及其精确使用契约。 */
export interface ModulesModuleApi {
 /** 注入宿主端口，装配到共享 Kernel。 */
 create(host:ModulesHost):OperationModuleDefinition
}
class ModulesModule implements ModulesModuleApi {
 public create(host:ModulesHost):OperationModuleDefinition{
  const catalog=new SystemCatalog(host)
  return {binding:{moduleId:ModulesModuleId,instanceId:'standard:modules',generation:SystemContract.generation,schemaRevision:SystemContract.schemaRevision},summary:'发现当前能力、读取系统包成员合同和使用模板',template:readFileSync(new URL('../modules-template.js',import.meta.url),'utf8').trim(),operations:{
   list:{summary:'按当前授权与空间筛选后分页列出包',input:{anyOf:[{type:'null'},querySchema]},output:modulePageSchema,effects:'none',run:(input,call)=>catalog.list(call.invocation.sessionId,(input??{}) as SystemModuleQuery)},
   search:{summary:'在当前授权包中按关键词和空间检索',input:{anyOf:[{type:'null'},querySchema]},output:modulePageSchema,effects:'none',run:(input,call)=>catalog.list(call.invocation.sessionId,(input??{}) as SystemModuleQuery)},
   describe:{summary:'读取包合同；system 可按 export 指定成员',input:objectSchema({module:{type:'string'},export:{type:'string'}},['module']),output:moduleDescriptionSchema,effects:'none',run:(input,call)=>{const value=input as {module:string;export?:string};return catalog.describe(call.invocation.sessionId,value.module,value.export)}},
  }}
 }
}
/** 注入端口之后接入唯一调用链。 */
export const modulesModule:ModulesModuleApi=new ModulesModule()
