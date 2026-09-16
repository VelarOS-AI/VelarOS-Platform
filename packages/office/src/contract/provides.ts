/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口（工具集合、能力服务）直接声明在这里。
 */

import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { KernelCallableCapabilityService } from '@velaros-ai/kernel/contracts/abi'
import type { ToolContractRuntimeSpec } from '@velaros-ai/tool-contract'

import type { OfficeToolName } from './constants.js'
import type { OfficeToolContext } from './requires.js'

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { MarkItDownLocatorApi } from '../impl/runtime/MarkItDownLocator.js'
export type { OfficeDocumentRendererApi } from '../impl/runtime/OfficeDocumentRenderer.js'

// ── 工具 ────────────────────────────────────────────────────────

/** 一个 office 工具的运行时规格：模型看到的信息面、入参 schema、权限、能力声明和 execute；上下文固定是宿主注入的 `OfficeToolContext`。 */
export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, OfficeToolContext, unknown, ToolPermission>

/**
 * office 空间的十个模型面工具，按工具名索引，实例是 `officeTools`。
 * 集合层面不区分各工具的入参类型：宿主拿模型给的入参先用该工具的 schema 校验，再调它的 execute。
 */
export type OfficeToolCollection = Readonly<Record<OfficeToolName, VelaTool<any>>>

/**
 * office 能力服务：本包作为内核模块激活后登记的服务，身份令牌是 `OfficeCapability`。
 * 宿主通过内核按工具名调用 office 工具；每次调用先解析入参，再向宿主解析一次上下文。
 */
export interface OfficeCapabilityService extends KernelCallableCapabilityService {
  /** 十个工具的只读视图，给只想读工具说明的宿主用。 */
  readonly tools: OfficeToolCollection
}

/** office 工具声明的权限轴；已统一用 agent 的 `ToolPermission`，这个名字只为兼容旧的导入保留。 */
export type OfficeToolPermission = ToolPermission
