/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口（工具集合、内置 mod 定义、能力服务、变更记录的只读视图）直接声明在这里。这里的每个接口都必须从根入口导出。
 */

import type { AgentModManifest, ToolCategoryDefinition, ToolPermission } from '@velaros-ai/agent/protocol'
import type {
  KernelCallableCapabilityService,
} from '@velaros-ai/kernel'
import type { ToolContractRuntimeSpec } from '@velaros-ai/tool-contract'

import type { ProjectChangeListener, ProjectChangeListOptions, ProjectChangeRecord } from '../types/change-feed.js'
import type { ProjectChangeReceipt } from '../types/project.js'

import type { ProjectCodeAnalysisToolName, ProjectModId, ProjectToolName } from './constants.js'
import type { ProjectToolContext } from './requires.js'

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ProjectKernel } from '../impl/kernel/LocalProjectKernel.js'
export type { ProjectApprovalBridgeApi } from '../impl/kernel/ProjectApprovalBridge.js'
export type { ProjectTransactionControllerApi } from '../impl/kernel/ProjectTransactionController.js'
export type { ProjectFileContextApi } from '../impl/operations/ProjectFileContext.js'
export type { FileProjectChangeFeedApi } from '../impl/persistence/FileProjectChangeFeed.js'

// ── 工具 ────────────────────────────────────────────────────────

/** 一个项目工具的运行时规格：模型看到的信息面、入参 schema、权限、能力声明和 execute；上下文固定是宿主注入的 `ProjectToolContext`。 */
export type VelaTool<TInput extends Record<string, any> = Record<string, any>> =
  ToolContractRuntimeSpec<TInput, ProjectToolContext, any, ToolPermission>

/**
 * 改动类工具（`project:edit` 的 apply）的运行时规格：成功回执里宿主界面可以依赖的字段由 `ProjectChangeReceipt` 定下，
 * 其余字段（源码窗口、差量、说明）只给模型看，跟着工具说明与上下文预算走。`projectTools` 里的 project:edit 就是它。
 */
export type ProjectEditTool<TInput extends Record<string, any> = Record<string, any>> =
  ToolContractRuntimeSpec<TInput, ProjectToolContext, ProjectChangeReceipt & Record<string, unknown>, ToolPermission>

/**
 * 按工具名索引的七个项目工具（其中 project:edit 满足 `ProjectEditTool`）：集合层面不区分各工具的入参类型，
 * 宿主拿模型给的入参先用该工具的 schema 严格校验，再调它的 execute。
 */
export type ProjectToolCollection = Readonly<Record<ProjectToolName, VelaTool<any>>>

/** 可选的 project:code-analysis：宿主有代码图后端时由 `createProjectCodeAnalysisTools(isAvailable)` 单独给出，只有这一个工具。 */
export type ProjectCodeAnalysisToolCollection = Readonly<Record<typeof ProjectCodeAnalysisToolName, VelaTool<any>>>

/**
 * 项目空间作为官方内置 mod 的定义，由 `createProjectBundledModDefinition()` 创建。
 * 产品壳的 mod 加载器按它把项目空间挂进来：清单声明工具、类别和空间，绑定里是七个工具与四个类别的实物。
 */
export interface ProjectBundledModDefinition {
  /** mod 身份，固定是 `velaros.project`。 */
  readonly id: typeof ProjectModId
  /** 加载器用的定位串，形如 `bundled:velaros.project`。 */
  readonly specifier: string
  /** 内置 mod 默认启用。 */
  readonly defaultEnabled: true
  /** mod 清单：版本、发布者、需要的能力轴，以及贡献的工具、工具类别和项目空间。 */
  readonly manifest: AgentModManifest
  /** 清单里声明的东西对应的实物。 */
  readonly bindings: {
    /** 七个工具。 */
    readonly tools: ProjectToolCollection
    /** 四个工具类别：文件、改动、执行、代码理解。 */
    readonly toolCategories: Readonly<Record<string, ToolCategoryDefinition>>
  }
}

// ── 内核挂载 ───────────────────────────────────────────────────

/**
 * 项目能力服务：本包作为内核模块激活后登记的服务，身份令牌是 `ProjectCapability`。
 * 宿主通过内核按工具名调用项目工具；每次调用先用 schema 严格解析入参，再向宿主解析一次上下文。
 */
export interface ProjectCapabilityService extends KernelCallableCapabilityService {
  /** 七个工具的只读视图，给只想读工具说明的宿主用。 */
  readonly tools: ProjectToolCollection
}

// ── 变更记录 ────────────────────────────────────────────────────

/** 项目变更记录的只读视图：每次提交的事务一条记录，界面和审计按它列出、查看、订阅项目改动。内核的 `changeFeed` 就是它。 */
export interface ProjectChangeFeed {
  /** 按选项列出变更记录，新的在前。 */
  list(options?: ProjectChangeListOptions): readonly ProjectChangeRecord[]
  /** 按事务号取一条记录；没有返回 undefined。 */
  get(transactionId: string): ProjectChangeRecord | undefined
  /** 订阅记录的增加与状态变化；返回取消订阅的函数。 */
  subscribe(listener: ProjectChangeListener): () => void
}
