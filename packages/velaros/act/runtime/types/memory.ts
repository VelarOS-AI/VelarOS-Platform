import type { ContextReadStamp,ContextRef } from "@velaros-ai/context";

/** 各分区共享总窗口；份额只控制可裁剪正文，最终请求仍由编译器计量。 */
export interface ContextMemoryPolicy {
  /** 自动携带的近期记录条数，0–64，主任务默认 8，搜索默认 64。 */
  readonly recentRecords?:number
  /** 工作区正文的目标份额，0.05–0.5；空闲容量可被观察和结果使用。 */
  readonly workspaceShare?:number
  /** 近期记录正文的目标份额，0–0.5。 */
  readonly recentShare?:number
}

/** 工作笔记的不可变版本，内容始终标为模型解释。 */
export interface WorkspaceNote {
  readonly key:string
  readonly revision:number
  readonly title:string
  readonly body:string
  readonly sources:readonly ContextRef[]
  readonly resident:boolean
  readonly stamps:readonly ContextReadStamp[]
  readonly origin:'model-note'
}
