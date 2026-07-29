import type { ScopeRef } from '../protocol/capability'

export interface OpenKernelSessionInput {
  readonly id: string
  readonly ownerModuleId: string
  readonly scope: ScopeRef | null
}

export interface StartKernelRunInput {
  readonly id: string
  readonly ownerModuleId: string
  readonly sessionId: string | null
}
