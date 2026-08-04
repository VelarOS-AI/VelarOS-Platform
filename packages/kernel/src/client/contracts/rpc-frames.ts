import type { KernelEvent } from '@velaros-ai/kernel/contracts/abi'

export const KernelRpcMethods = [
  'handshake',
  'health',
  'capability.session.open',
  'capability.session.close',
  'capability.call',
  'capability.cancel',
  'session.open',
  'session.get',
  'session.list',
  'session.close',
  'run.start',
  'run.get',
  'run.list',
  'run.finish',
  'events.subscribe',
  'events.unsubscribe',
  'mods.list',
  'mods.setEnabled',
  'mods.installFromDirectory',
] as const

export type KernelRpcMethod = (typeof KernelRpcMethods)[number]

export interface KernelRpcRequest {
  readonly type: 'request'
  readonly requestId: string
  readonly authToken: string
  readonly method: KernelRpcMethod
  readonly params: unknown
}

export interface KernelRpcError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details: Nullable<Readonly<Record<string, unknown>>>
}

export interface KernelRpcSuccess {
  readonly type: 'response'
  readonly requestId: string
  readonly status: 'ok'
  readonly result: unknown
}

export interface KernelRpcFailure {
  readonly type: 'response'
  readonly requestId: string
  readonly status: 'error'
  readonly error: KernelRpcError
}

export type KernelRpcResponse = KernelRpcSuccess | KernelRpcFailure

export interface KernelRpcEventFrame {
  readonly type: 'event'
  readonly subscriptionId: string
  readonly event: KernelEvent
}

export type KernelRpcServerFrame = KernelRpcResponse | KernelRpcEventFrame
