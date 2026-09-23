import { isBlank, isEmpty, isNull, isObject, isPlainObject, isString } from '@velaros-ai/core'

import type { KernelRpcMethod } from '../../contract/constants'
import {
  KernelClientErrorCodes,
  KernelErrorCodes,
  KernelRpcMethods,
} from '../../contract/constants'
import type { KernelRpcFailure, KernelRpcRequest } from '../../types/wire'
import { KernelClientError, KernelError } from '../errors'

const methodSet: ReadonlySet<string> = new Set(KernelRpcMethods)

/** 把一帧收进来的 JSON 解成 RPC 请求；类型不对、字段缺失或方法名不认识时抛带码的错误。 */
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
  const authToken = isString(record.authToken) ? record.authToken : ''
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

/** 断言一个值是普通对象并原样返回；不是就抛 `INVALID_PARAMS`。 */
export function requireRecord(
  input: unknown,
  message = 'RPC 的 params 必须是一个对象'
): Readonly<Record<string, unknown>> {
  if (isPlainObject(input)) return input as Readonly<Record<string, unknown>>
  throw new KernelClientError({ code: 'INVALID_PARAMS', message })
}

/** 断言某个字段是非空字符串并返回它；不是就抛 `INVALID_PARAMS`，消息里点名是哪个字段。 */
export function requireNonEmptyString(input: unknown, field: string): string {
  if (isString(input) && !isBlank(input.trim())) return input
  throw new KernelClientError({
    code: 'INVALID_PARAMS',
    message: `RPC 字段 "${field}" 必须是非空字符串`,
  })
}

/** 折一个 RPC 失败帧：码与说明原样带回调用方，`retryable` 说明值不值得再试一次。 */
export function rpcFailure(
  requestId: string,
  code: string,
  message: string,
  retryable = false,
  details: Nullable<Readonly<Record<string, unknown>>> = null
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

/**
 * 从一份还没解出来的帧里尽力读出 requestId。
 *
 * 帧本身不合协议时也要回一个能对上号的失败帧；读不出来就用 `invalid-frame` 占位。
 */
export function readKernelRpcRequestId(input: unknown): string {
  if (!isObject(input) || isNull(input)) return 'invalid-frame'
  const requestId = Reflect.get(input, 'requestId')
  return isString(requestId) && !isEmpty(requestId) ? requestId : 'invalid-frame'
}

/** 从 RPC 参数里读一个必填的非空字符串 id（取消调用的 requestId、退订的 subscriptionId）。 */
export function readRequiredKernelRpcId(params: unknown, field: string): string {
  return requireNonEmptyString(requireRecord(params)[field], field)
}

/**
 * 把内核侧的错误投影成 wire 失败帧。
 *
 * 带码的错误一律按自己的码投影：原来只认三个错误类，`mods.*` 那条线的失败（没接 ModStore、
 * 目录安装失败）全被吞成「INTERNAL_ERROR，可重试」，真正的原因只进守护进程日志，调用方
 * 重试多少次都一样。
 */
export function toKernelRpcFailure(requestId: string, error: unknown): KernelRpcFailure {
  if (error instanceof KernelClientError) return rpcFailure(requestId, error.code, error.message)
  if (error instanceof KernelError)
    return rpcFailure(
      requestId,
      error.code,
      error.message,
      // 「还没启动」是等一等就好的状态；别的带码失败重试也是同一个结果。
      error.code === KernelErrorCodes.kernelNotStarted,
      error.details as Readonly<Record<string, unknown>>
    )
  return rpcFailure(requestId, KernelClientErrorCodes.internalError, 'Kernel RPC 请求失败', true)
}
