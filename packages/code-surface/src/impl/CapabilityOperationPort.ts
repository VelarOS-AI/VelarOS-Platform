/**
 * 把一张操作表接成能力端口：登记、转发、整形错误。
 *
 * 这三件事对每个能力空间一模一样，写一遍就够；空间那边只剩「怎么做」。
 * 注意**审批与危险判定不在这里**——它们在操作方法自己内部（`ctx.approval`），
 * 这是代码面能成立的前提：一次调用才是可审查单元，一段程序不是。
 */

import { isEmpty, isUndefined } from '@velaros-ai/core'

import type { CodeCapabilityCall, CodeCapabilityOutcome, CodeCapabilityPort } from '../contract/requires.js'
import type { CodeAttachment } from '../types/code-surface.js'
import type { CapabilityOperationTable } from '../types/operations.js'
import { describeUnknownOperation, shapeOperationFailure } from '../utils/capability-failure.js'

class CapabilityOperationPort implements CodeCapabilityPort {
  public constructor(private readonly table: CapabilityOperationTable) {}

  public listOperations(): Readonly<Record<string, readonly string[]>> {
    return Object.fromEntries(
      Object.entries(this.table).map(([namespace, operations]) => [namespace, Object.keys(operations)])
    )
  }

  public async invoke(call: CodeCapabilityCall, signal?: AbortSignal): Promise<CodeCapabilityOutcome> {
    const namespace = this.table[call.namespace]
    const operation = namespace?.[call.operation]
    if (isUndefined(operation)) return { error: describeUnknownOperation(call, namespace) }

    // 不在这里校验：入参合不合法是那件能力自己的事，它本来就要拦。
    // 盖在这一层只会变成第二个主人，而且换个入口就漏。
    // 图不进返回值：操作经 attach 交出来，端口单独收着，跟在结果旁边回去。
    const attachments: CodeAttachment[] = []
    try {
      const value = await operation(call.input, { signal, attach: (attachment) => attachments.push(attachment) })
      const outcome: CodeCapabilityOutcome = { value }
      if (!isEmpty(attachments)) outcome.attachments = attachments
      return outcome
    } catch (cause) {
      return { error: shapeOperationFailure(cause) }
    }
  }
}

/** 装一个能力端口：空间交一张操作表，拿回代码面要的那个端口。 */
export function createCapabilityPort(table: CapabilityOperationTable): CodeCapabilityPort {
  return new CapabilityOperationPort(table)
}
