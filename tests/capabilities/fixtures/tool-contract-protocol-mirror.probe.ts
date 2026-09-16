/**
 * 同形副本的探针：`@velaros-ai/tool-contract` 的可移植文件里那几个工具协议类型，
 * 与 `@velaros-ai/agent` 可移植文件里的同源声明必须互相可赋值。
 * 两边形状一旦分叉，这个文件就编译不过；`tool-contract-protocol-mirror.test.ts` 编译它并断言零诊断。
 */

import type * as Agent from '../../../packages/agent/src/types/agent.js'
import type * as Mirror from '../../../packages/tool-contract/src/types/tool-contract.js'

/** 两个类型互相可赋值时为 true，任一方向不成立就是 false。 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

export const permission: Mutual<Mirror.ToolPermission, Agent.ToolPermission> = true
export const categoryId: Mutual<Mirror.ToolCategoryId, Agent.ToolCategoryId> = true
export const role: Mutual<Mirror.ToolContractRole, Agent.ToolRole> = true
export const surfaceProfileId: Mutual<Mirror.ToolSurfaceProfileId, Agent.ToolSurfaceProfileId> = true
export const modality: Mutual<Mirror.ToolModelInputModality, Agent.AgentModelInputModality> = true
export const exposureProfileId: Mutual<Mirror.ToolExposureProfileId, Agent.RunProfileId> = true
export const effectKind: Mutual<Mirror.ToolCapabilityEffectKind, Agent.ToolCapabilityEffectKind> = true
export const sourceScope: Mutual<Mirror.ToolCapabilitySourceScope, Agent.ToolCapabilitySourceScope> = true
export const filesystemScope: Mutual<Mirror.ToolCapabilityFilesystemScope, Agent.ToolCapabilityFilesystemScope> = true
export const concurrency: Mutual<Mirror.ToolCapabilityConcurrency, Agent.ToolCapabilityConcurrency> = true
export const transaction: Mutual<Mirror.ToolCapabilityTransactionSchema, Agent.ToolCapabilityTransactionSchema> = true
export const capabilitySchema: Mutual<Mirror.ToolCapabilitySchema, Agent.ToolCapabilitySchema> = true
export const exposureTier: Mutual<Mirror.ToolExposureTier, Agent.ToolExposureTier> = true
export const exposureProfilePolicy: Mutual<Mirror.ToolExposureProfilePolicy, Agent.ToolExposureProfilePolicy> = true
export const exposurePolicy: Mutual<Mirror.ToolExposurePolicy, Agent.ToolExposurePolicy> = true
