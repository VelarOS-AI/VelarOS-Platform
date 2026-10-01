import type { ContextContent, ContextRef, ContextViewApi } from '@velaros-ai/context'
import type { ModelHistoryMessage, ModelImage, OperationRuntimeApi } from '@velaros-ai/kernel'
import type { MemoryScopePort } from '@velaros-ai/velaros/memory'

import type { StoreSessionApi } from '../impl/StoreSession.js'
import type { GoalState, GoalUpdate } from '../types/goal.js'
import type {
  ContextMaintenancePage,
  ContextMaterialsQuery,
  ContextMaterialsReadInput,
  ContextPatch,
  ContextPatchReceipt,
} from '../types/maintenance.js'
import type {
  MemoryContent,
  MemoryOrganizeIntent,
  MemoryOrganizeReceipt,
  MemoryPage,
  MemoryQuery,
  MemoryRetention,
} from '../types/memory.js'
import type {
  SystemModuleDescription,
  SystemModulePage,
  SystemModuleQuery,
} from '../types/modules.js'
import type { ScriptRetention } from '../types/results.js'
import type { WorkspaceEntry, WorkspaceUpdate } from '../types/workspace.js'

/** 模型记忆使用现有会话存储和任务控制面。 */
export interface MemoryHost {
  /** 宿主显式提供的主线长期记忆；数据不进入会话笔记存储。 */
  readonly longTermMemory?: LongTermMemoryHost
  /** 当前会话的笔记和原文访问。 */
  programs(sessionId: string): MemorySession
  /** 主模型自己的计划更新口。 */
  view(sessionId: string): Pick<ContextViewApi, 'updateCapsule'>
  /** 有界整理服务。 */
  readonly maintenance?: ContextMaintenanceHost
}
/** 长期记忆的作用域和主线整理能力，由装配层固定。 */
export interface LongTermMemoryHost {
  /** 返回宿主为已打开主会话固定的记忆端口；模型不能选择作用域。 */
  scope(sessionId: string): MemoryScopePort
  /** 主线是否具备整理模型，决定实际合同是否生成 organize。 */
  readonly organize: boolean
}
/** 工作记忆的宿主端口。 */
export interface MemorySession {
  /** 原有工作区和归档的统一访问。 */
  readonly memory: MemoryStore
}
/** 只复用当前会话的授权存储。 */
export interface MemoryStore {
  /** 主模型更新自己的不可变笔记版本。 */
  update(input: WorkspaceUpdate, signal: AbortSignal): Promise<WorkspaceEntry>
  /** 元数据分页和查找。 */
  catalog(input: MemoryQuery, signal: AbortSignal): Promise<MemoryPage>
  /** 统一召回用户输入、脚本、结果、笔记和材料。 */
  readMaterial(
    ref: ContextRef | string,
    offset: Optional<number>,
    limit: Optional<number>,
    signal: AbortSignal,
    pointer?: string,
    invocation?: string
  ): Promise<MemoryContent>
  /** 保留或释放当前笔记、执行结果的驻留。 */
  retainMaterial(
    ref: ContextRef | string,
    turns: Nullable<ScriptRetention>,
    signal: AbortSignal
  ): Promise<MemoryRetention>
}
/** 能力发现和派发使用同一权限范围。 */
export interface ModulesHost {
  /** 当前会话是否具备模块。 */
  allows(sessionId: string, module: string): boolean
  /** 唯一 Kernel 目录。 */
  kernel(): Pick<OperationRuntimeApi, 'list' | 'describe'>
}
/** 系统包共用宿主的两个窄端口。 */
export interface SystemHost extends GoalHost, ModulesHost {
  /** 持久状态存储可用时装配的共享能力。 */
  readonly stores?: StoreHost
}
/** 按调用会话解析固定共享空间。 */
export interface StoreHost {
  /** 返回该会话获配的状态端口。 */
  stores(sessionId: string): StoreSessionApi
}

/** 整理服务仅接受意图，材料访问只给活动整理会话。 */
export interface ContextMaintenanceHost {
  /** 安排下一请求边界整理，返回持久请求身份。 */
  request(
    id: string,
    intent: MemoryOrganizeIntent,
    signal: AbortSignal
  ): Promise<MemoryOrganizeReceipt>
  /** 固定父快照的目录分页。 */
  listMaterials(
    id: string,
    query: ContextMaterialsQuery,
    signal: AbortSignal
  ): Promise<ContextMaintenancePage>
  /** 按快照引用读取父会话原文页。 */
  readMaterial(
    id: string,
    input: ContextMaterialsReadInput,
    signal: AbortSignal
  ): Promise<ContextContent>
  /** 校验并受理整理会话交来的补丁；发布在整理收束之后。 */
  submitPatch(id: string, patch: ContextPatch, signal: AbortSignal): Promise<ContextPatchReceipt>
}
/** 整理候选通过真实父模型编译器后才发布。 */
export interface ContextCandidateValidator {
  /** 验证五分区和原生附件，不运行脚本。 */
  validateCandidate(
    frame: {
      body: string
      prompt: string
      history: readonly ModelHistoryMessage[]
      images: readonly ModelImage[]
    },
    signal: AbortSignal
  ): Promise<void>
}

/** 当前会话目标的注入边界。 */
export interface GoalHost extends MemoryHost {
  /** 实际调用会话的目标服务。 */
  programs(sessionId: string): MemorySession & {
    /** 与宿主读取相同的目标账本。 */
    readonly goal: GoalLedger
  }
}
/** 一个会话的目标账本：宿主读取与模型更新共用同一份，版本、状态迁移与内容上限都由它核对。 */
export interface GoalLedger {
  /** 当前版本，缺失返回空。 */
  get(signal: AbortSignal): Promise<Nullable<GoalState>>
  /** 只允许模型合同中的状态变化。 */
  update(input: GoalUpdate, signal: AbortSignal): Promise<GoalState>
}

// ── 各成员操作每次调用的宿主上下文：由本单元的装配从上面的宿主端口按调用会话建出来 ──
/** 已按一个会话的授权筛过的模块目录。 */
export interface ModuleCatalogPort {
  /** 授权与空间筛选后分页。 */
  list(query: SystemModuleQuery): SystemModulePage
  /** 读取包或指定成员的真实合同。 */
  describe(module: string, member?: string): SystemModuleDescription
}

/** `velaros:modules` 每次调用的宿主上下文：本会话看得到的模块目录与取消信号。 */
export interface ModulesOperationContext {
  /** 本会话的模块目录。 */
  readonly catalog: ModuleCatalogPort
  /** 调用的取消信号。 */
  readonly abortSignal: AbortSignal
}

/** `velaros:system-memory*` 每次调用的宿主上下文：本会话的笔记与原文、计划更新口，以及按装配给出的整理服务与长期记忆作用域。 */
export interface SystemMemoryOperationContext {
  /** 本会话的笔记与原文访问。 */
  readonly memory: MemoryStore
  /** 本会话的计划更新口。 */
  readonly plans: Pick<ContextViewApi, 'updateCapsule'>
  /** 本会话的整理服务；没有整理能力的装配不给。 */
  readonly organizer?: MemoryOrganizerPort
  /** 宿主为主会话固定的长期记忆作用域；没装配长期记忆时不给。 */
  readonly longTerm?: MemoryScopePort
  /** 这次执行的身份：计划更新归属于它。 */
  readonly executionId: string
  /** 调用的取消信号。 */
  readonly abortSignal: AbortSignal
}

/** 一个会话的整理请求口。 */
export interface MemoryOrganizerPort {
  /** 安排下一请求边界整理，返回持久请求身份。 */
  request(intent: MemoryOrganizeIntent, signal: AbortSignal): Promise<MemoryOrganizeReceipt>
}

/** `velaros:system-store*` 每次调用的宿主上下文：本会话的空间端口、Kernel 调用号（写入按它核对与幂等）与取消信号。 */
export interface StoreOperationContext {
  /** 本会话获配的空间端口。 */
  readonly store: StoreSessionApi
  /** 这次 Kernel 调用的身份。 */
  readonly invocationId: string
  /** 调用的取消信号。 */
  readonly abortSignal: AbortSignal
}

/** 一个整理会话看得到的父快照材料。 */
export interface ContextMaterialsPort {
  /** 快照目录分页。 */
  list(query: ContextMaterialsQuery, signal: AbortSignal): Promise<ContextMaintenancePage>
  /** 按快照引用读取原文页。 */
  read(input: ContextMaterialsReadInput, signal: AbortSignal): Promise<ContextContent>
  /** 交来整理补丁。 */
  submit(patch: ContextPatch, signal: AbortSignal): Promise<ContextPatchReceipt>
}

/** `velaros:context-materials` 每次调用的宿主上下文：本整理会话的父快照材料与取消信号。 */
export interface ContextMaterialsOperationContext {
  /** 本整理会话的父快照材料。 */
  readonly materials: ContextMaterialsPort
  /** 调用的取消信号。 */
  readonly abortSignal: AbortSignal
}

/** `velaros:system-goal` 每次调用的宿主上下文：本会话的目标账本与取消信号，模型指定不了别的会话。 */
export interface GoalOperationContext {
  /** 本会话的目标账本。 */
  readonly goal: GoalLedger
  /** 调用的取消信号。 */
  readonly abortSignal: AbortSignal
}
