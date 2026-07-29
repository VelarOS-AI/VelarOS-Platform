// 健康度状态是 module ABI 的既有词汇（`../abi/module`），服务面契约直接复用同一份定义——
// P2 合并前它在 kernel-client 里被逐字抄了第二遍，合并后按「共享件归位」去重（宪章 §15.4 裁决二）。
import type { KernelModuleHealthStatus as ModuleHealthStatus } from '../abi/module'

export type { KernelModuleHealthStatus } from '../abi/module'

/** Mirrors the host's module lifecycle states as they appear on the wire. */
export type KernelModuleRuntimeStatus =
  | 'registered'
  | 'activating'
  | 'active'
  | 'readying'
  | 'ready'
  | 'suspending'
  | 'suspended'
  | 'disposing'
  | 'disposed'
  | 'failed'

export interface KernelServiceModuleHealth {
  readonly id: string
  readonly version: string
  readonly generation: number
  readonly status: KernelModuleRuntimeStatus
  readonly health: {
    readonly status: ModuleHealthStatus
    readonly message?: string
    readonly details?: Readonly<Record<string, unknown>>
  }
  readonly error?: string
}

export interface KernelServiceHealth {
  readonly status: 'healthy' | 'degraded' | 'stopped'
  readonly modules: readonly KernelServiceModuleHealth[]
}
