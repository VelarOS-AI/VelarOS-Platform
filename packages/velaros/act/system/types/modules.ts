import type { ModuleBinding } from '@velaros-ai/kernel'

/** 模型层模块发现查询。 */
export interface SystemModuleQuery {
 /** 关键词。 */
 readonly query?:string
 /** 先授权过滤再分页的偏移。 */
 readonly offset?:number
 /** 当前页大小。 */
 readonly limit?:number
 /** 查询系统包、任务能力或全部。 */
 readonly space?:'system'|'capability'|'all'
}
/** 可导入包卡片；聚合包的真实身份由成员描述提供。 */
export interface SystemModuleCard {
 /** 模型导入名。 */
 readonly specifier:string
 /** 所属空间。 */
 readonly space:'system'|'capability'
 /** 简介。 */
 readonly summary:string
 /** 可调用操作，聚合包使用成员点操作名。 */
 readonly operations:readonly string[]
 /** 业务模块的真实绑定。 */
 readonly binding?:ModuleBinding
 /** 聚合包可见成员。 */
 readonly exports?:readonly string[]
}
/** 当前授权目录的一页。 */
export interface SystemModulePage {
 /** 可见卡片。 */
 readonly items:readonly SystemModuleCard[]
 /** 后续偏移，没有更多时为 null。 */
 readonly nextOffset:Nullable<number>
}
