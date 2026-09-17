/** 能力那一侧的两件整形：调了个没有的操作怎么说、抛出来的东西怎么变成程序看得懂的错误。都不碰实例状态。 */

import { isUndefined } from '@velaros-ai/core'

import { CodeSurfaceErrorCodes } from '../contract/constants.js'
import type { CodeCapabilityOutcome } from '../contract/requires.js'
import type { CapabilityNamespaceOperations } from '../types/operations.js'

/** 调了个没有的操作时，把这个命名空间**有**哪些一并说了——模型下一轮才改得对。 */
export function describeUnknownOperation(
  call: { namespace: string; operation: string },
  namespace: Optional<CapabilityNamespaceOperations>
): NonNullable<CodeCapabilityOutcome['error']> {
  const available = isUndefined(namespace) ? '' : Object.keys(namespace).join('、')
  return {
    code: CodeSurfaceErrorCodes.unknownOperation,
    message:
      available.length === 0
        ? `没有 ${call.namespace} 这个命名空间。`
        : `${call.namespace} 里没有 ${call.operation} 这个操作。有的是：${available}。`,
  }
}

/**
 * 把操作抛出来的东西整形成程序里看得懂的错误。
 *
 * 能力自己带了码就用它的——码是能力定的，代码面不解释它；没带的按「这次调用失败了」算。
 * 一律**不吞**：程序里它是个能 `try/catch` 的异常，模型可以接住换条路，也可以让它把整段程序带停。
 */
export function shapeOperationFailure(cause: unknown): NonNullable<CodeCapabilityOutcome['error']> {
  const known = cause as { code?: unknown; message?: unknown }
  const message = typeof known.message === 'string' && known.message.length > 0 ? known.message : String(cause)
  return typeof known.code === 'string' && known.code.length > 0
    ? { code: known.code, message }
    : { code: CodeSurfaceErrorCodes.operationFailed, message }
}
