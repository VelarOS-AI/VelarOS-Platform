import type { Awaitable, KernelRegistration } from './module.js'

export interface KernelEvent<TPayload = unknown> {
  readonly type: string
  readonly payload: TPayload
  readonly sourceModuleId: string
  readonly sourceGeneration: number
  readonly sequence: number
}

export type KernelEventHandler<TPayload = unknown> = (
  event: KernelEvent<TPayload>,
) => Awaitable<void>

/** Module-scoped event surface; source ownership is supplied by the host. */
export interface KernelModuleEventBus {
  publish<TPayload>(
    type: string,
    payload: TPayload,
  ): Promise<KernelEvent<TPayload>>
  subscribe<TPayload>(
    type: string,
    handler: KernelEventHandler<TPayload>,
  ): KernelRegistration
}
