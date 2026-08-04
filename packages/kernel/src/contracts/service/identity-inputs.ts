import type { ScopeRef } from '../protocol/capability'

export interface OpenKernelSessionInput {
  readonly id: string
  readonly ownerModuleId: string
  readonly scope: Nullable<ScopeRef>
}

export interface StartKernelRunInput {
  readonly id: string
  readonly ownerModuleId: string
  readonly sessionId: Nullable<string>
}
