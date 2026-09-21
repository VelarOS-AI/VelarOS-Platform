import {isNull,isUndefined} from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import type { ModuleCard } from '@velaros-ai/kernel'
import { scriptPackageCompiler } from '@velaros-ai/script'

import { LocalMemoryModuleId, LocalSystemPackage, PersistentMemoryModuleId,PersistentSystemPackage, StoreModuleId,StoreReadModuleId,StoreWriteModuleId,SystemCatalogLimits, SystemPackage } from '../contract/constants.js'
import type { ModulesHost } from '../contract/requires.js'
import type { SystemModuleCard, SystemModulePage, SystemModuleQuery } from '../types/modules.js'

/** 当前会话的规范包目录。 */
export interface SystemCatalogApi {
 /** 授权与空间筛选后分页。 */
 list(sessionId:string,query:SystemModuleQuery):SystemModulePage
 /** 读取包或指定成员的真实合同。 */
 describe(sessionId:string,module:string,member?:string):unknown
}
export class SystemCatalog implements SystemCatalogApi {
 public constructor(private readonly host:ModulesHost){}
 private available(sessionId:string):ModuleCard[]{
  const items:ModuleCard[]=[];let offset:Nullable<number>=0
  while(!isNull(offset)){const page=this.host.kernel().list({offset});items.push(...page.items.filter(item=>this.host.allows(sessionId,item.binding.moduleId)));offset=page.nextOffset}
  return items
 }
 public list(sessionId:string,query:SystemModuleQuery):SystemModulePage{
  const available=this.available(sessionId)
  const exports=Object.entries({...(available.some(item=>item.binding.moduleId===PersistentMemoryModuleId)?PersistentSystemPackage.exports:available.some(item=>item.binding.moduleId===LocalMemoryModuleId)?LocalSystemPackage.exports:SystemPackage.exports),store:available.some(item=>item.binding.moduleId===StoreReadModuleId)?StoreReadModuleId:available.some(item=>item.binding.moduleId===StoreWriteModuleId)?StoreWriteModuleId:StoreModuleId}).filter(([,id])=>available.some(item=>item.binding.moduleId===id))
  const ids=new Set<string>([...Object.values(SystemPackage.exports),LocalMemoryModuleId,PersistentMemoryModuleId,StoreReadModuleId,StoreWriteModuleId])
  const system:SystemModuleCard={specifier:SystemPackage.specifier,space:'system',summary:'发现能力，维护记忆、共享状态与材料引用',exports:exports.map(([name])=>name),operations:exports.flatMap(([name,id])=>available.find(item=>item.binding.moduleId===id)!.operations.map(operation=>`${name}.${operation}`))}
  const cards:SystemModuleCard[]=[...(!isEmpty(exports)?[system]:[]),...available.filter(item=>!ids.has(item.binding.moduleId)).map(item=>({...item,specifier:item.binding.moduleId,space:'capability' as const}))]
  const keyword=query.query?.trim().toLowerCase()
  const filtered=cards.filter(card=>(!query.space||query.space==='all'||card.space===query.space)&&(!keyword||`${card.specifier} ${card.summary} ${card.operations.join(' ')}`.toLowerCase().includes(keyword))).sort((a,b)=>a.specifier.localeCompare(b.specifier))
  const offset=query.offset??0; const limit=Math.min(query.limit??SystemCatalogLimits.page,SystemCatalogLimits.maxPage)
  return {items:filtered.slice(offset,offset+limit),nextOffset:offset+limit<filtered.length?offset+limit:null}
 }
 public describe(sessionId:string,module:string,member?:string):unknown{
  const available=this.available(sessionId)
  if(module!==SystemPackage.specifier){
   if(!isUndefined(member))throw Object.assign(new Error('成员查询只适用于聚合包'),{code:'MODULE_EXPORT'})
   if(!this.host.allows(sessionId,module))throw Object.assign(new Error('当前会话没有此能力'),{code:'CAPABILITY_DENIED'})
   const description=this.host.kernel().describe(module)
   const entry=Object.entries({...(available.some(item=>item.binding.moduleId===PersistentMemoryModuleId)?PersistentSystemPackage.exports:available.some(item=>item.binding.moduleId===LocalMemoryModuleId)?LocalSystemPackage.exports:SystemPackage.exports),store:available.some(item=>item.binding.moduleId===StoreReadModuleId)?StoreReadModuleId:available.some(item=>item.binding.moduleId===StoreWriteModuleId)?StoreWriteModuleId:StoreModuleId}).find(([,id])=>id===module)
   const result={...description,specifier:entry?SystemPackage.specifier:module,space:entry?'system':'capability'}
   if(entry)Object.assign(result,{export:entry[0]})
   return result
  }
  const entries=Object.entries({...(available.some(item=>item.binding.moduleId===PersistentMemoryModuleId)?PersistentSystemPackage.exports:available.some(item=>item.binding.moduleId===LocalMemoryModuleId)?LocalSystemPackage.exports:SystemPackage.exports),store:available.some(item=>item.binding.moduleId===StoreReadModuleId)?StoreReadModuleId:available.some(item=>item.binding.moduleId===StoreWriteModuleId)?StoreWriteModuleId:StoreModuleId}).filter(([name,id])=>(isUndefined(member)||member===name)&&available.some(item=>item.binding.moduleId===id))
  if(isEmpty(entries))throw Object.assign(new Error('系统成员不存在或未授权'),{code:'CAPABILITY_DENIED'})
  const descriptions=Object.fromEntries(entries.map(([name,id])=>[name,this.host.kernel().describe(id)]))
  const projection={specifier:SystemPackage.specifier,exports:Object.fromEntries(entries)}
  const compiled=scriptPackageCompiler.compile([projection],Object.values(descriptions).map(item=>({namespace:item.binding.moduleId,declarations:item.declarations})))
  return {specifier:module,space:'system',exports:descriptions,declarations:compiled.granted.map(item=>item.declarations).join('\n'),template:member?descriptions[member]!.template:`// 当前成员：${entries.map(([name])=>name).join(', ')}\nimport {output} from 'velaros';\nimport * as system from 'velaros:system';\nasync function usage(){output(Object.keys(system));}`}
 }
}
