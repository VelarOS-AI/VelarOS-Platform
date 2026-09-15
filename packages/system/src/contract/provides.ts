/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口（工具集合、内置 mod 定义、能力服务）直接声明在这里。这里的每个接口都必须从根入口导出。
 */

import type { AgentModManifest, ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { ToolContractRuntimeSpec } from '@velaros-ai/agent/tool-contract'
import type { KernelCallableCapabilityService } from '@velaros-ai/kernel/contracts/abi'

import type { SystemModId, SystemToolCategoryId, SystemToolName } from './constants.js'
import type { SystemToolContext } from './requires.js'

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { LocalSystemKernelApi } from '../impl/LocalSystemKernel.js'

// ── 工具 ────────────────────────────────────────────────────────

/** 一个系统工具的运行时规格：模型看到的信息面、入参 schema、权限、能力声明和 execute；上下文固定是宿主注入的 `SystemToolContext`。 */
export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, SystemToolContext, unknown, ToolPermission>

/**
 * 系统空间的七个模型面工具，按工具名索引，实例是 `systemTools`。
 * 集合层面不区分各工具的入参类型：宿主拿模型给的入参先用该工具的 schema 严格校验，再调它的 execute。
 */
export type SystemToolCollection = Readonly<Record<SystemToolName, VelaTool<any>>>

/**
 * 系统空间作为官方内置 mod 的定义，由 `createSystemBundledModDefinition()` 创建。
 * 产品壳的 mod 加载器按它把系统空间挂进来：清单声明工具、类别和空间，绑定里是七个工具与两个类别的实物。
 */
export interface SystemBundledModDefinition {
  /** mod 身份，固定是 `velaros.system`。 */
  readonly id: typeof SystemModId
  /** 加载器用的定位串，形如 `bundled:velaros.system`。 */
  readonly specifier: string
  /** 内置 mod 默认启用。 */
  readonly defaultEnabled: true
  /** mod 清单：版本、发布者、需要的能力轴，以及贡献的工具、工具类别和系统空间。 */
  readonly manifest: AgentModManifest
  /** 清单里声明的东西对应的实物。 */
  readonly bindings: {
    /** 七个工具。 */
    readonly tools: SystemToolCollection
    /** 两个工具类别：文件、执行。 */
    readonly toolCategories: Readonly<Record<SystemToolCategoryId, ToolCategoryDefinition>>
  }
}

/**
 * 系统能力服务：本包作为内核模块激活后登记的服务，身份令牌是 `SystemCapability`。
 * 宿主通过内核按工具名调用系统工具；每次调用先用 schema 严格解析入参，再向宿主解析一次上下文。
 */
export interface SystemCapabilityService extends KernelCallableCapabilityService {
  /** 七个工具的只读视图，给只想读工具说明的宿主用。 */
  readonly tools: SystemToolCollection
}
