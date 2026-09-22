import type { ContextContent, ContextRef, ContextViewApi } from '@velaros-ai/context'
import type { ModelHistoryMessage, ModelImage,OperationRuntimeApi } from '@velaros-ai/kernel'
import type {MemoryScopePort} from '@velaros-ai/velaros/memory'

import type {StoreSessionApi} from '../impl/StoreSession.js'
import type { MemoryOrganizeIntent, MemoryPage, MemoryQuery } from '../types/memory.js'
import type { ScriptRetention } from '../types/results.js'
import type {GoalState,GoalUpdate} from '../types/goal.js'
import type { WorkspaceEntry, WorkspaceUpdate } from '../types/workspace.js'

/** 模型记忆使用现有会话存储和任务控制面。 */
export interface MemoryHost {
 /** 宿主显式提供的主线长期记忆；数据不进入会话笔记存储。 */
 readonly longTermMemory?:LongTermMemoryHost
 /** 当前会话的笔记和原文访问。 */
 programs(sessionId:string):MemorySession
 /** 主模型自己的计划更新口。 */
 view(sessionId:string):Pick<ContextViewApi,'updateCapsule'>
 /** 有界整理服务。 */
 readonly maintenance?:ContextMaintenanceHost
}
/** 长期记忆的作用域和主线整理能力，由装配层固定。 */
export interface LongTermMemoryHost {
 /** 返回宿主为已打开主会话固定的记忆端口；模型不能选择作用域。 */
 scope(sessionId:string):MemoryScopePort
 /** 主线是否具备整理模型，决定实际合同是否生成 organize。 */
 readonly organize:boolean
}
/** 工作记忆的宿主端口。 */
export interface MemorySession {
 /** 原有工作区和归档的统一访问。 */
 readonly memory:MemoryStore
}
/** 只复用当前会话的授权存储。 */
export interface MemoryStore {
 /** 主模型更新自己的不可变笔记版本。 */
 update(input:WorkspaceUpdate,signal:AbortSignal):Promise<WorkspaceEntry>
 /** 元数据分页和查找。 */
 catalog(input:MemoryQuery,signal:AbortSignal):Promise<MemoryPage>
 /** 统一召回用户输入、脚本、结果、笔记和材料。 */
 readMaterial(ref:ContextRef|string,offset:Optional<number>,limit:Optional<number>,signal:AbortSignal):Promise<ContextContent>
 /** 保留或释放当前笔记、执行结果的驻留。 */
 retainMaterial(ref:ContextRef|string,turns:Nullable<ScriptRetention>,signal:AbortSignal):Promise<unknown>
}
/** 能力发现和派发使用同一权限范围。 */
export interface ModulesHost {
 /** 当前会话是否具备模块。 */
 allows(sessionId:string,module:string):boolean
 /** 唯一 Kernel 目录。 */
 kernel():Pick<OperationRuntimeApi,'list'|'describe'>
}
/** 系统包共用宿主的两个窄端口。 */
export interface SystemHost extends GoalHost,ModulesHost {
 /** 持久状态存储可用时装配的共享能力。 */
 readonly stores?:StoreHost
}
/** 按调用会话解析固定共享空间。 */
export interface StoreHost {
 /** 返回该会话获配的状态端口。 */
 stores(sessionId:string):StoreSessionApi
}

/** 整理服务仅接受意图，材料访问只给活动整理会话。 */
export interface ContextMaintenanceHost {
 /** 安排下一请求边界整理，返回持久请求身份。 */
 request(id:string,intent:MemoryOrganizeIntent,signal:AbortSignal):Promise<unknown>
 /** 固定父快照的目录或正文分页。 */
 materials(id:string,input:{ref?:ContextRef;after?:number;offset?:number;limit?:number},signal:AbortSignal):Promise<unknown>
}
/** 整理候选通过真实父模型编译器后才发布。 */
export interface ContextCandidateValidator {
 /** 验证五分区和原生附件，不运行脚本。 */
 validateCandidate(frame:{body:string;prompt:string;history:readonly ModelHistoryMessage[];images:readonly ModelImage[]},signal:AbortSignal):Promise<void>
}

/** 当前会话目标的注入边界。 */
export interface GoalHost extends MemoryHost {
 /** 实际调用会话的目标服务。 */
 programs(sessionId:string):MemorySession & {
  /** 与宿主读取相同的目标账本。 */
  readonly goal:{
   /** 当前版本，缺失返回空。 */
   get(signal:AbortSignal):Promise<Nullable<GoalState>>
   /** 只允许模型合同中的状态变化。 */
   update(input:GoalUpdate,signal:AbortSignal):Promise<GoalState>
  }
 }
}
