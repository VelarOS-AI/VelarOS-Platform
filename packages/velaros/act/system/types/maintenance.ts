import type { ContextInputSummary, ContextRecord, ContextRef, TaskCapsule } from '@velaros-ai/context'
import type { ScriptOutputEdit, ScriptOutputManifest } from '@velaros-ai/script'

import type { HistoryCheckpoint } from './history.js'
import type { MemoryOrganizeIntent } from './memory.js'

/** 整理支线看到的只读快照说明；正文按本快照授权的引用读取。 */
export interface ContextMaintenanceSnapshot {
 /** 本轮主线工作意图与保留要求。 */
 readonly intent?:MemoryOrganizeIntent
 /** 发起请求的稳定身份，自动整理为空。 */
 readonly requestId?:string
 /** 当前任务使用的空间引用；释放只改变自动展示。 */
 readonly storeRefs?:readonly string[]
 readonly baseRevision:string
 readonly targetChars:number
 readonly through:number
 readonly totalRecords:number
 readonly goals:readonly ContextRef[]
 readonly capsule:TaskCapsule
 readonly observationRef:Nullable<string>
 /** 最新观察结果及可管理的源码规则，不复制结果正文。 */
 readonly observation?:{readonly resultRef:Nullable<string>;readonly manifest:ScriptOutputManifest;readonly blocks:ReadonlyArray<{readonly key:string;readonly contentHash:string;readonly chars:number}>}
 /** 用户目标代次，用于使旧摘要失效。 */
 readonly taskRevision:string
 readonly protectedRefs:readonly ContextRef[]
 /** 输入摘要版本及当前摘要原文引用；既有约束从该引用读取后保留。 */
 readonly inputRevisions:ReadonlyArray<{readonly ref:ContextRef;readonly revision:number;readonly summaryRef?:ContextRef}>
}

/** 模型只提交元数据变更，最终发布由 Runtime 完成。 */
export interface ContextPatch {
 readonly baseRevision:string
 readonly summary:string
 readonly unresolved:readonly string[]
 readonly notes?:readonly ContextNotePresentation[]
 readonly inputs?:readonly ContextInputSummary[]
 readonly history?:HistoryCheckpoint
 /** 退出自动展示的空间引用，不删除对象、取消订阅或撤销权限。 */
 readonly releaseStoreRefs?:readonly string[]
 readonly releaseResults?:readonly string[]
 readonly observation?:ScriptOutputEdit & {readonly sourceRef:string;readonly summaries?:ReadonlyArray<{readonly key:string;readonly resultRef:string;readonly contentHash:string;readonly text:string}>}
 readonly recentRecords?:number
}

/** 持续应用到后续新帧的呈现预算，原始数据和源码保持原有归属。 */
export interface ContextProjectionPolicy {
 /** 与不可变笔记版本绑定的派生展示，不写回主模型笔记。 */
 readonly notes?:readonly ContextNotePresentation[]
 /** 自动整理的派生正文只在本次成功业务轮内生效；显式设置可以持续到任务结束。 */
 readonly expiresAfterTurn?:number
 readonly origin:'model-interpretation'
 /** 经编译验证的容量持续到下一策略或任务切换，不随临时正文过期。 */
 readonly maxChars:number
 readonly recentRecords?:number
 readonly summary:string
 readonly unresolved:readonly string[]
 readonly report:ContextRef
}

/** 整理材料目录只给出原始元数据。 */
export interface ContextMaintenancePage {
 readonly items:readonly ContextRecord[]
 readonly nextAfter:Nullable<number>
}

/** 整理模型只能改变某一原始版本的展示。 */
export interface ContextNotePresentation {
 /** 精确不可变笔记引用；主模型更新后自动失效。 */
 readonly ref:ContextRef
 /** 可选派生摘要，保持解释来源。 */
 readonly summary?:string
 /** false 只退出自动展示，原文仍可召回。 */
 readonly resident?:boolean
}
