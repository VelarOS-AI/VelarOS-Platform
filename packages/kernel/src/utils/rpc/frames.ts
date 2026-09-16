import { isBlank, isPlainObject, isString } from '@velaros-ai/core'

import {
  type KernelRpcFailure,
  type KernelRpcMethod,
  KernelRpcMethods,
  type KernelRpcRequest,
} from '../../types/client-rpc-frames'
import { KernelClientError } from '../errors'

const methodSet: ReadonlySet<string> = new Set(KernelRpcMethods)

export function decodeKernelRpcRequest(input: unknown): KernelRpcRequest {
  const record = requireRecord(input, 'RPC 帧必须是一个对象')
  if (record.type !== 'request') {
    throw new KernelClientError({
      code: 'INVALID_RPC_FRAME',
      message: 'RPC 帧的 type 必须是 "request"',
    })
  }
  const requestId = requireNonEmptyString(record.requestId, 'requestId')
  const method = requireNonEmptyString(record.method, 'method')
  const authToken = isString(record.authToken)
    ? record.authToken
    : ''
  if (!methodSet.has(method)) {
    throw new KernelClientError({
      code: 'METHOD_NOT_FOUND',
      message: `RPC 方法 "${method}" 不存在`,
    })
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
  message = 'RPC 的 params 必须是一个对象',
): Readonly<Record<string, unknown>> {
  if (isPlainObject(input)) return input as Readonly<Record<string, unknown>>
  throw new KernelClientError({ code: 'INVALID_PARAMS', message })
}

export function requireNonEmptyString(
  input: unknown,
  field: string,
): string {
  if (isString(input) && !isBlank(input.trim())) return input
  throw new KernelClientError({
    code: 'INVALID_PARAMS',
    message: `RPC 字段 "${field}" 必须是非空字符串`,
  })
}

export function rpcFailure(
  requestId: string,
  code: string,
  message: string,
  retryable = false,
  details: Nullable<Readonly<Record<string, unknown>>> = null,
): KernelRpcFailure {
  return {
    type: 'response',
    requestId,
    status: 'error',
    error: {
      code,
      message,
      retryable,
      details,
    },
  }
}
