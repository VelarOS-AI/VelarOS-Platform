import type { KernelRpcError } from './contracts/rpc-frames'

export type KernelClientErrorCode =
  | 'DAEMON_ALREADY_RUNNING'
  | 'DAEMON_DESCRIPTOR_INVALID'
  | 'DAEMON_NOT_RUNNING'
  | 'PROTOCOL_VERSION_MISMATCH'

/** Stable wire / call error codes for capability session binding. */
export const KernelCapabilityGrantErrorCodes = {
  NOT_GRANTED: 'CAPABILITY_NOT_GRANTED',
  NOT_AVAILABLE: 'CAPABILITY_NOT_AVAILABLE',
  BIND_DENIED: 'CAPABILITY_BIND_DENIED',
  NOT_FOUND: 'CAPABILITY_NOT_FOUND',
} as const

export type KernelCapabilityGrantErrorCode =
  (typeof KernelCapabilityGrantErrorCodes)[keyof typeof KernelCapabilityGrantErrorCodes]

/** Discovery and connection failures that occur before or around the RPC hop. */
export class KernelClientError extends Error {
  public constructor(
    public readonly code: KernelClientErrorCode,
    message: string,
    public readonly guidance?: string,
  ) {
    super(message)
    this.name = 'KernelClientError'
  }
}

/** Transport-level and Kernel-reported failures carrying the wire error shape. */
export class KernelRpcClientError extends Error {
  public constructor(public readonly rpcError: KernelRpcError) {
    super(rpcError.message)
    this.name = 'KernelRpcClientError'
  }

  public get code(): string {
    return this.rpcError.code
  }

  public get retryable(): boolean {
    return this.rpcError.retryable
  }
}
