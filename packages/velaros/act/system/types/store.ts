import type {AgentStoreGrant} from '@velaros-ai/agent'
import type {StoreChanges,StoreDescriptor,StoreEventCard,StoreEventPage} from '@velaros-ai/context'
/** 同一数据合同用于宿主授权和子任务派发。 */
export type StoreGrant=AgentStoreGrant
/** 宿主固定的存储边界及可用空间。 */
export interface StoreConfiguration {
 /** 租户或项目边界，模型不能修改。 */
 readonly scope:string
 /** 是否允许创建，主线默认允许。 */
 readonly create?:boolean
 /** 其他创建者的空间授权。 */
 readonly grants?:readonly StoreGrant[]
}
/** 目录中的实际访问范围。 */
export type StoreEntry=StoreDescriptor & {readonly access:{readonly read:readonly string[];readonly write:readonly string[]}}
/** 多空间共用一份交付预算，正文仍按需读取。 */
export interface StoreFrame {
 /** 当前任务的稳定空间引用；正文按需读取，省略量明确反馈。 */
 readonly active:{
  /** 逻辑任务身份，尚未开始时为空。 */
  readonly taskId:Nullable<string>
  /** 本帧可容纳的当前任务引用。 */
  readonly items:ReadonlyArray<{readonly id:string;readonly name:string;readonly description:string;readonly descriptionTruncated:boolean}>
  /** 当前授权范围内的活跃空间总数。 */
  readonly total:number
  /** 未放入本帧的引用数，通过 list({active:true}) 分页读取。 */
  readonly omitted:number
 }
 /** 获配目录的第一页，完整列表通过 store.list 获取。 */
 readonly items:readonly StoreEntry[]
 /** 目录后续页游标。 */
 readonly nextAfter:Nullable<string>
 /** 实际交付的变化及各自的确认位置。 */
 /** 独立消息元数据和待处理数量；正文由 events 显式读取。 */
 readonly messages:ReadonlyArray<Omit<StoreEventPage,'events'> & {readonly store:string;readonly events:readonly StoreEventCard[]}>
 readonly changes:ReadonlyArray<StoreChanges & {readonly store:string}>
}
