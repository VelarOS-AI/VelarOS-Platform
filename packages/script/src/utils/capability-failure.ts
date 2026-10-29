/** 能力那一侧的几件整形：调了个没有的操作怎么说、抛出来的东西怎么变成程序看得懂的错误、哪些失败算「被拒」。都不碰实例状态。 */

import { isEmpty, isString, isUndefined } from '@velaros-ai/core'

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
  const message = isString(known.message) && !isEmpty(known.message) ? known.message : String(cause)
  return isString(known.code) && !isEmpty(known.code)
    ? { code: known.code, message }
    : { code: CodeSurfaceErrorCodes.operationFailed, message }
}

/** 上游超时与取消保留原原因；停止执行不等于能力授权失败。 */
export function shapeExecutionStop(reason: unknown): NonNullable<CodeCapabilityOutcome['error']> {
  const error = reason instanceof Error ? reason : undefined
  return {
    code:
      error?.name === 'TimeoutError' || (error && 'code' in error && error.code === 'TIMEOUT')
        ? 'TIMEOUT'
        : 'ABORTED',
    message: error?.message || '执行已取消。',
  }
}

/** 能力报的码里带这几个词的，是用户或空间的策略说了不（PERMISSION、PERMISSION_DENIED、FILES_EDIT_DENIED、APPROVAL_DENIED……）。 */
const RefusalCodePattern = /DENIED|PERMISSION/u

/**
 * 这次失败是不是「被拒」。被拒要进 notices：就算程序把异常吞了，模型也得知道用户或策略没同意，别换个写法再撞一次。
 * 找不到、不唯一、版本对不上这类是调用自己的结果，程序接得住、也看得见，不在 notices 里再回放一遍。
 */
export function isRefusal(code: string): boolean {
  return RefusalCodePattern.test(code)
}
