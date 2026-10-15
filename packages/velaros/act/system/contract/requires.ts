import type { ContextContent, ContextRef, ContextViewApi } from '@velaros-ai/context'
import type { ExclusiveSqliteLockApi } from '@velaros-ai/core/utils/ExclusiveSqliteLock'
import type { ModelHistoryMessage, ModelImage, OperationRuntimeApi } from '@velaros-ai/kernel'
import type { NodeRuntimeEnvironment } from '@velaros-ai/script'
import type { NpmClientApi } from '@velaros-ai/velaros/execution'
import type { MemoryScopePort } from '@velaros-ai/velaros/memory'

import type { StoreSessionApi } from '../impl/StoreSession.js'
import type {
  ExecutionRead,
  ExecutionSnapshot,
  ExecutionTarget,
  ExecutionWait,
} from '../types/executions.js'
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
  SystemModuleDescribeInput,
  SystemModuleDescription,
  SystemModulePage,
  SystemModuleQuery,
} from '../types/modules.js'
import type {
  ProgramDescribeInput,
  ProgramDescriptor,
  ProgramPage,
  ProgramPublishInput,
  ProgramQuery,
} from '../types/programs.js'
import type { ScriptRetention } from '../types/results.js'
import type { WorkspaceEntry, WorkspaceUpdate } from '../types/workspace.js'

import type { EnvironmentRegistryApi } from './provides.js'

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
export interface SystemHost extends GoalHost, ModulesHost, ProgramsHost, ExecutionsHost {
  /** 当前运行时固定的 npm 环境。 */
  readonly packageEnvironment?: EnvironmentRegistryApi
  /** 持久状态存储可用时装配的共享能力。 */
  readonly stores?: StoreHost
}

/** 宿主指定的持久 npm 环境，模型不能改变存储作用域。 */
export interface EnvironmentRegistryOptions {
  /** 独立于业务工作区的绝对根目录，每个 agent 使用稳定目录。 */
  readonly directory: string
  /** 标准 npm 的受控进程口。 */
  readonly npm: NpmClientApi
  /** 自定义宿主可提供跨进程锁，默认使用独立 node:sqlite 连接。 */
  readonly lock?: ExclusiveSqliteLockApi
  /** Skill 等固定导入名，冲突时要求使用 npm alias。 */
  readonly reservedPackages?: readonly string[]
}

/** 一次执行持有的依赖快照；只有进程树收束后才能释放。 */
export interface EnvironmentLease {
  /** 进程树回收不完整时保留文件，等待宿主核对后释放。 */
  retain(): Promise<void>
  /** 安装完成且不会原地修改的运行依赖。 */
  readonly environment: NodeRuntimeEnvironment
  /** 本快照的命令搜索目录。 */
  readonly binDirectories: readonly string[]
  /** 幂等释放磁盘租约。 */
  release(): Promise<void>
}

/** npm 环境每次调用的固定宿主上下文。 */
export interface EnvironmentOperationContext {
  /** 宿主为本 agent 绑定的环境。 */
  readonly registry: EnvironmentRegistryApi
  /** 当前调用的取消信号。 */
  readonly abortSignal: AbortSignal
  /** 按实际执行与发布时间记录效果。 */
  recordEffect(effect: 'none' | 'committed' | 'unknown'): void
}
/** 程序复用只接当前会话的原有归档与权限边界。 */
export interface ProgramsHost {
  /** 提供时挂载 programs 成员；数据与语法检查由运行时持有。 */
  readonly programCatalog?: (sessionId: string) => ProgramCatalogPort
}
/** 发布与发现不运行程序；sourceRef 执行继续由正式 Runtime 接受与派发。 */
export interface ProgramCatalogPort {
  /** 检查真实源码/import，然后按名称版本 CAS 发布不可变源与目录。 */
  publish(input: ProgramPublishInput, signal: AbortSignal): Promise<ProgramDescriptor>
  /** 按当前授权与重置边界过滤后分页。 */
  list(query: ProgramQuery, signal: AbortSignal): Promise<ProgramPage>
  /** 当前名称或不可变版本，均重新核对可见性与授权。 */
  describe(input: ProgramDescribeInput, signal: AbortSignal): Promise<ProgramDescriptor>
}
/** programs 的每次调用上下文由宿主固定实际会话。 */
export interface ProgramsOperationContext {
  /** 本次真实会话的程序发布与发现端口。 */
  readonly catalog: ProgramCatalogPort
  /** 调用取消信号，发布与查询都须响应。 */
  readonly abortSignal: AbortSignal
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
  /** 按引用读取当前整理请求或父快照的原文页。 */
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
  /** 父循环在容量不足时使用的原文投影上限；候选只在超窗后本地重投影一次。 */
  readonly recoveryChars?: number
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
  describe(input: SystemModuleDescribeInput): SystemModuleDescription
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
  /** 按引用读取当前整理请求或父快照的原文页。 */
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

/** 当前调用会话的作业口，由 Runtime 按逻辑任务核对。 */
export interface ExecutionsHost {
  /** 按真实会话取得当前任务的执行端口。 */
  readonly executions?: (sessionId: string) => ExecutionsPort
}
/** 执行状态与停止走同一持久身份，绝不自动重放源码。 */
export interface ExecutionsPort {
  /** 检查当前任务身份后读取状态与有界输出。 */
  read(input: ExecutionRead, signal: AbortSignal): Promise<ExecutionSnapshot>
  /** 有界等待已有执行终态；取消只结束本次等待，不能等待调用者自身。 */
  wait(
    input: ExecutionWait,
    callerExecutionId: string,
    signal: AbortSignal
  ): Promise<ExecutionSnapshot>
  /** 请求定向停止，防止调用者停止自己。 */
  stop(
    input: ExecutionTarget,
    callerExecutionId: string,
    signal: AbortSignal
  ): Promise<ExecutionSnapshot>
}
/** 宿主绑定当前执行身份，模型参数不能伪造调用者。 */
export interface ExecutionsOperationContext {
  /** 已固定当前会话的执行控制口。 */
  readonly executions: ExecutionsPort
  /** 实际发起调用的程序身份。 */
  readonly executionId: string
  /** 当前调用的取消信号。 */
  readonly abortSignal: AbortSignal
  /** 记录停止请求是否已经提交。 */
  recordEffect(effect: 'none' | 'committed' | 'unknown'): void
}
