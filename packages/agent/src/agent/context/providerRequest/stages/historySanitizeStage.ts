/**
 * Ring 1 stage ①——history-sanitize（孤儿自愈，守护清单资产整器官平移）。
 *
 * 流中止 / 异常会在持久历史里留下孤儿 tool-result 或不完整 tool-call 组，导致此后每次 send
 * 都被 assertValidModelHistory 拦下、会话被永久锁死。编译前后各做一次结构修复（丢弃孤儿、
 * 回填 / 移除缺结果的组），让会话从损坏中恢复，而不是硬报错。这是「4 次 mid-tool-call 中止
 * 0 brick」的唯一保障，一克不减。
 */
import type { ModelMessage } from 'ai'

import { logRuntime } from '@velaros-ai/core/logger'

import { repairHistoryStructureForProvider } from '../../../history/repair'

const log = logRuntime.tag('ProviderRequestCompiler')

/**
 * 对历史做一次结构自愈：有改动才替换（并按需告警），无改动原样返回。
 * `log` 区分两处调用——首处（去重后）告警可观测，末处（注意力 / 保留上下文重排后）静默。
 */
export function applyHistoryStructureRepair(
  messages: ModelMessage[],
  options: { log: boolean }
): ModelMessage[] {
  const repair = repairHistoryStructureForProvider(messages)
  if (repair.removedMessages === 0 && repair.changedMessages === 0) return messages

  if (options.log) {
    log.warn('provider 历史结构自愈：清理了中止/异常留下的孤儿或不完整 tool 消息', {
      removedMessages: repair.removedMessages,
      changedMessages: repair.changedMessages,
      issues: repair.issues.slice(0, 5).map((issue) => issue.kind),
    })
  }

  return repair.history
}
