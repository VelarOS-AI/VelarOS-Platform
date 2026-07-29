export type KernelModuleHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'

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
    readonly status: KernelModuleHealthStatus
    readonly message?: string
    readonly details?: Readonly<Record<string, unknown>>
  }
  readonly error?: string
}

export interface KernelServiceHealth {
  readonly status: 'healthy' | 'degraded' | 'stopped'
  readonly modules: readonly KernelServiceModuleHealth[]
}
