// 健康度状态与模块生命周期状态直接复用 module ABI 的唯一事实来源。
import type { KernelModuleHealth, KernelModuleStatus } from '../abi/module'

export type { KernelModuleHealthStatus } from '../abi/module'

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
