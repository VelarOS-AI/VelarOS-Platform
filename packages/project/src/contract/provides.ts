/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口（工具集合、内置 mod 定义、项目空间、能力服务、变更记录的只读视图）直接声明在这里。这里的每个接口都必须从根入口导出。
 */

import type { AgentModManifest, ToolCategoryDefinition, ToolPermission } from '@velaros-ai/agent/protocol'
import type { ToolContractRuntimeSpec } from '@velaros-ai/agent/tool-contract'
import type { KernelCallableCapabilityService } from '@velaros-ai/kernel/contracts/abi'

import type { ProjectKernel } from '../impl/kernel/LocalProjectKernel.js'
import type { ProjectChangeListener, ProjectChangeListOptions, ProjectChangeRecord } from '../types/change-feed.js'

import type { ProjectCodeAnalysisModId, ProjectModId, ProjectSpaceId } from './constants.js'
import type { ProjectToolContext } from './requires.js'

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ProjectKernel } from '../impl/kernel/LocalProjectKernel.js'
export type { ProjectTransactionControllerApi } from '../impl/kernel/ProjectTransactionController.js'
export type { ProjectApprovalBridgeApi } from '../impl/operations/ProjectApprovalBridge.js'
export type { ProjectFileContextApi } from '../impl/operations/ProjectFileContext.js'
export type { FileProjectChangeFeedApi } from '../impl/persistence/FileProjectChangeFeed.js'

// ── 工具 ────────────────────────────────────────────────────────

/** 一个项目工具的运行时规格：模型看到的信息面、入参 schema、权限、能力声明和 execute；上下文固定是宿主注入的 `ProjectToolContext`。 */
export type VelaTool<TInput extends Record<string, any> = Record<string, any>> =
  ToolContractRuntimeSpec<TInput, ProjectToolContext, any, ToolPermission>

/**
 * 按工具名索引的项目工具：默认的九个是 `projectTools`，可选的 project:code-analysis 由 `createProjectCodeAnalysisTools` 单独给出。
 * 集合层面不区分各工具的入参类型：宿主拿模型给的入参先用该工具的 schema 严格校验，再调它的 execute。
 */
export type ProjectToolCollection = Readonly<Record<string, VelaTool<any>>>

/**
 * 项目空间作为官方内置 mod 的定义，由 `createProjectBundledModDefinition()` 创建。
 * 产品壳的 mod 加载器按它把项目空间挂进来：清单声明工具、类别和空间，绑定里是九个工具与四个类别的实物。
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
    /** 九个工具。 */
    readonly tools: ProjectToolCollection
    /** 四个工具类别：文件、改动、执行、代码理解。 */
    readonly toolCategories: Readonly<Record<string, ToolCategoryDefinition>>
  }
}

/**
 * 代码图分析扩展作为可选内置 mod 的定义，由 `createProjectCodeAnalysisContribution(isAvailable)` 创建。
 * 只贡献 project:code-analysis 一个工具；宿主有代码图后端时单独挂载，isAvailable 决定每次调用时它在不在。
 */
export interface ProjectCodeAnalysisContribution {
  /** mod 身份，固定是 `velaros.project.code-analysis`。 */
  readonly id: typeof ProjectCodeAnalysisModId
  /** 版本，跟本包一致。 */
  readonly version: string
  /** mod 清单：只声明工具这一个能力轴，工具只在项目空间里可用。 */
  readonly manifest: AgentModManifest
  /** 清单里声明的东西对应的实物。 */
  readonly bindings: {
    /** 只有 project:code-analysis。 */
    readonly tools: ProjectToolCollection
  }
}

// ── 项目空间与内核挂载 ─────────────────────────────────────────

/** 项目空间：一个项目根上的领域内核加九个工具，由 `createProjectSpace(options)` 创建。 */
export interface ProjectSpace {
  /** 空间身份，固定是 `project`。 */
  readonly id: typeof ProjectSpaceId
  /** 这个项目根上的领域内核：读写、事务、校验与撤销都经过它。 */
  readonly kernel: ProjectKernel
  /** 九个工具。 */
  readonly tools: ProjectToolCollection
}

/**
 * 项目能力服务：本包作为内核模块激活后登记的服务，身份令牌是 `ProjectCapability`。
 * 宿主通过内核按工具名调用项目工具；每次调用先用 schema 严格解析入参，再向宿主解析一次上下文。
 */
export interface ProjectCapabilityService extends KernelCallableCapabilityService {
  /** 九个工具的只读视图，给只想读工具说明的宿主用。 */
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
