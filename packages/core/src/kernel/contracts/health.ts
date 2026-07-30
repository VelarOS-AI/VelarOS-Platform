// 健康度状态与模块生命周期状态都是 module ABI 的既有词汇（`../abi/module`），服务面契约直接
// 复用同一份定义——P2 合并前它们在 kernel-client 里被逐字抄了第二遍，合并后按「共享件归位」
// 去重（宪章 §15.4 裁决二）。`KernelModuleRuntimeStatus` 保留为 wire 侧的历史名，指向同一联合。
import type { KernelModuleHealth, KernelModuleStatus } from '../abi/module'

export type { KernelModuleHealthStatus } from '../abi/module'
export type { KernelModuleStatus as KernelModuleRuntimeStatus } from '../abi/module'

export interface KernelServiceModuleHealth {
  readonly id: string
  readonly version: string
  readonly generation: number
  readonly status: KernelModuleStatus
  readonly health: KernelModuleHealth
  readonly error?: string
}

export interface KernelServiceHealth {
  readonly status: 'healthy' | 'degraded' | 'stopped'
  readonly modules: readonly KernelServiceModuleHealth[]
}
