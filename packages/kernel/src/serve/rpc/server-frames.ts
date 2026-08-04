import { isBlank, isPlainObject, isString } from '@velaros-ai/core'
import {
  type KernelRpcFailure,
  type KernelRpcMethod,
  KernelRpcMethods,
  type KernelRpcRequest,
} from '@velaros-ai/kernel/client/contracts'


export class KernelRpcProtocolError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'KernelRpcProtocolError'
  }
}

const methodSet: ReadonlySet<string> = new Set(KernelRpcMethods)

export function decodeKernelRpcRequest(input: unknown): KernelRpcRequest {
  const record = requireRecord(input, 'RPC frame must be an object')
  if (record.type !== 'request') {
    throw new KernelRpcProtocolError(
      'INVALID_RPC_FRAME',
      'RPC frame type must be "request"',
    )
  }
  const requestId = requireNonEmptyString(record.requestId, 'requestId')
  const method = requireNonEmptyString(record.method, 'method')
  const authToken = isString(record.authToken)
    ? record.authToken
    : ''
  if (!methodSet.has(method)) {
    throw new KernelRpcProtocolError(
      'METHOD_NOT_FOUND',
      `RPC method "${method}" is not available`,
    )
  }
  return {
    type: 'request',
    requestId,
    authToken,
    method: method as KernelRpcMethod,
    params: record.params,
  }
}

export function requireRecord(
  input: unknown,
  message = 'RPC params must be an object',
): Readonly<Record<string, unknown>> {
  if (isPlainObject(input)) return input as Readonly<Record<string, unknown>>
  throw new KernelRpcProtocolError('INVALID_PARAMS', message)
}

export function requireNonEmptyString(
  input: unknown,
  field: string,
): string {
  if (isString(input) && !isBlank(input.trim())) return input
  throw new KernelRpcProtocolError(
    'INVALID_PARAMS',
    `RPC field "${field}" must be a non-empty string`,
  )
}

export function rpcFailure(
  requestId: string,
  code: string,
  message: string,
  retryable = false,
): KernelRpcFailure {
  return {
    type: 'response',
    requestId,
    status: 'error',
    error: {
      code,
      message,
      retryable,
      details: null,
    },
  }
}
