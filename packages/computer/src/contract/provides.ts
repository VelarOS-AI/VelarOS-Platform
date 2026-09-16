/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口（工具集合、能力服务）直接声明在这里。这里的每个接口都必须从入口导出。
 */

import type { ToolPermission } from '@velaros-ai/agent/contracts'
import type {
  KernelCallableCapabilityService,
} from '@velaros-ai/kernel'
import type { ToolContractRuntimeSpec } from '@velaros-ai/tool-contract'

import type { ComputerToolName } from './constants.js'
import type { ComputerRuntimePort, ComputerToolContext } from './requires.js'

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ComputerHelperLocatorApi } from '../impl/ComputerHelperLocator.js'
export type { ComputerRuntimeApi } from '../impl/ComputerSidecarManager.js'

/** 一个桌面控制工具的运行时规格：模型看到的信息面、入参 schema、权限、能力声明和 execute；上下文固定是宿主注入的 `ComputerToolContext`。 */
export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, ComputerToolContext, unknown, ToolPermission>

/**
 * 桌面控制的五个模型面工具，按工具名索引，实例是 `computerTools`。
 * 集合层面不区分各工具的入参类型：宿主拿模型给的入参先用该工具的 schema 严格校验，再调它的 execute。
 */
export type ComputerToolCollection = Readonly<Record<ComputerToolName, VelaTool<any>>>

/**
 * 桌面控制能力服务：本包作为内核模块激活后登记的服务，身份令牌是 `ComputerCapability`。
 *
 * 两面合一：`invoke` 按工具名调工具（入参先按工具 schema 严格解析，再向宿主要上下文），
 * 另一面把运行时方法直接挂出来，供已经持有服务、不经 wire 面的宿主直调。
 */
export interface ComputerCapabilityService
  extends ComputerRuntimePort, KernelCallableCapabilityService {
  /** 五个工具的只读视图，给只想读工具说明的宿主用。 */
  readonly tools: ComputerToolCollection
}
