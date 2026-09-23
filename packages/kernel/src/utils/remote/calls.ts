// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:一次调用在两端之间的小换算——截止时长、wire 作用域形态、失败文案与错误落位。
//
// 这些判断都不需要连接状态,单独放在这里是为了让调用簿与隔离适配器只剩「记账」和「转投」。
import { isNonBlankString, isNull, isPresent, isUndefined, toNullable } from '@velaros-ai/core'

import { RemoteNodeClientErrorCodes } from '../../contract/constants'
import type { ScopeRef } from '../../types/kernel'
import type { RemoteNodeCapabilityBinding } from '../../types/remote'
import type { RemoteNodeInvokeRequest } from '../../types/remote-client'
import { permissionDeniedFailure, RemoteNodeClientError } from '../errors'
import { KernelTuning } from '../tuning'
import type { RemoteNodeError, RemoteNodeInvoke } from '../wire/remote-node'

/** 一次调用的可读名字 `<能力>.<操作>`;只进日志与失败文案。 */
export function describeRemoteNodeCall(request: RemoteNodeInvokeRequest): string {
  return `${request.capabilityId}.${request.operation}`
}

/** 本次调用的截止时长:调用方没给、给了非数或非正数时回落到缺省值。 */
export function resolveRemoteNodeDeadlineMs(request: RemoteNodeInvokeRequest): number {
  const requested = request.deadlineMs
  if (isUndefined(requested) || !Number.isFinite(requested) || requested <= 0)
    return KernelTuning.remoteClientDefaultDeadlineMs
  return Math.round(requested)
}

/** ABI 的 `kind?: string` 与 wire 的 `kind: string | null` 在此对齐,只此一处。 */
export function toRemoteNodeWireScope(scope: LooseOptional<ScopeRef>): RemoteNodeInvoke['scope'] {
  if (!isPresent(scope)) return null
  return {
    id: scope.id,
    ownerModuleId: scope.ownerModuleId,
    kind: toNullable(scope.kind),
  }
}

/** 把 Node 回的失败信封拼成一句可读文案;没有信封时只给兜底那句。 */
export function describeRemoteNodeError(
  error: Nullable<RemoteNodeError>,
  fallback: string
): string {
  if (isNull(error)) return fallback
  return `${fallback}: ${error.message} (${error.code})`
}

/**
 * 远端失败在本机 Kernel 上的落位。
 *
 * `denied` 是 Node 侧派发后的策略事实,必须变成 Kernel 的权限拒绝——它会一路走到模型面前,
 * 而链路故障不该。其余一律保留 `RemoteNodeClientError` 原样上抛:它的 code / message /
 * retryable 与 Kernel wire 错误信封同构,`resultUnknown` 这一位也不能在转投中丢掉。
 */
export function toRemoteNodeKernelError(
  binding: RemoteNodeCapabilityBinding,
  operation: string,
  error: unknown
): unknown {
  if (!(error instanceof RemoteNodeClientError)) return error
  if (error.code !== RemoteNodeClientErrorCodes.CallDenied) return error

  const declared = binding.operations
    .find((descriptor) => descriptor.name === operation)
    ?.permissions.at(0)
  const nodeCode = error.nodeError?.code
  const permission = isNonBlankString(nodeCode)
    ? nodeCode
    : (declared ?? binding.remoteCapabilityId)
  return permissionDeniedFailure({
    capabilityId: binding.localCapabilityId,
    operation,
    permission,
    reason: error.message,
  })
}

/** 实例已回收后的统一拒绝因由;不可重试,也不存在半执行。 */
export function remoteNodeDisposedError(): RemoteNodeClientError {
  return new RemoteNodeClientError({
    code: RemoteNodeClientErrorCodes.Disposed,
    message: '远程节点客户端已回收',
    resultUnknown: false,
    retryable: false,
  })
}

/** 一次调用被中止时交回调用方的错误;名字按 DOM 约定叫 `AbortError`,上层按它判断。 */
export function createAbortError(): Error {
  return new DOMException('Remote node call aborted', 'AbortError')
}
