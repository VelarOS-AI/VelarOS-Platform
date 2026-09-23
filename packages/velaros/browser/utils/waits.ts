/** 宿主这一侧的轮询等待：等挂起事件出现、等页面判定式成立、等 CDP 事件到来。等不到一律抛 `TIMEOUT`，message 说等了什么、最后看到什么。 */

import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { BrowserErrorCodes } from '../contract/constants.js'
import type { BrowserPendingEventSummary, BrowserProtocolEvent } from '../types/browser.js'
import type {
  BrowserPageConditionPollOptions,
  BrowserPendingEventWaitOptions,
  BrowserProtocolEventWaitOptions,
} from '../types/operations.js'

import { scriptOutcomeValue } from './script-outcome.js'
import { BrowserTuning } from './tuning.js'

/** 轮询挂起事件表，等指定类别的事件出现，交回它；到期没等到抛 `TIMEOUT`，message 列出此刻挂着的事件。 */
export async function waitForPendingEvent(
  options: BrowserPendingEventWaitOptions
): Promise<BrowserPendingEventSummary> {
  const startedAt = Date.now()
  let pending: BrowserPendingEventSummary[] = []
  while (Date.now() - startedAt <= options.timeoutMs) {
    options.abortSignal.throwIfAborted()
    pending = (await options.listPendingEvents()).pending
    const event = pending.find((candidate) => candidate.kind === options.kind)
    if (event) return event
    await TimerScope.sleep(BrowserTuning.session.pendingEventPollIntervalMs, {
      label: 'browser.waitForPendingEvent',
      signal: options.abortSignal,
    })
  }
  const waiting = pending.map((event) => event.kind).join('、') || '没有'
  throw new AppError(
    'TIMEOUT',
    `等了 ${options.timeoutMs} 毫秒，没有等到 ${options.kind} 事件；此刻挂着的事件：${waiting}。`
  )
}

/**
 * 宿主每隔 intervalMs 在当前页面上跑一次判定式，结果为真就交回它。页面跳转途中的那一拍（求值没有回话、上下文没了）算还没到，
 * 新页面上接着判；页面里抛错直接抛 `BROWSER_SCRIPT_FAILED`，指定的框架没了抛 `BROWSER_FRAME_NOT_FOUND`；到期没成立抛 `TIMEOUT`。
 */
export async function pollPageCondition(
  options: BrowserPageConditionPollOptions
): Promise<unknown> {
  const deadline = Date.now() + options.timeoutMs
  let lastSeen = '还没判过一次'
  while (Date.now() < deadline) {
    options.abortSignal.throwIfAborted()
    const outcome = await options
      .evaluate(Math.min(deadline - Date.now(), BrowserTuning.wait.conditionTickTimeoutMs))
      .catch((error: unknown) => {
        // 跳转途中这一拍没有结果，下一拍在新页面上接着判；框架没了、用户中止这类判不下去的原样抛出去。
        const failure = AppError.from(error)
        if (failure.code === BrowserErrorCodes.frameNotFound || options.abortSignal.aborted)
          throw error
        lastSeen = `页面这一拍没有回话（${failure.message}）`
        return null
      })
    if (outcome) {
      const value = scriptOutcomeValue(outcome)
      if (value) return value
      lastSeen = `判定式的值是 ${JSON.stringify(value) ?? 'undefined'}，页面 ${outcome.url}`
    }
    const pause = Math.min(options.intervalMs, deadline - Date.now())
    if (pause > 0)
      await TimerScope.sleep(pause, {
        label: 'browser.pollPageCondition',
        signal: options.abortSignal,
      })
  }
  throw new AppError('TIMEOUT', `等了 ${options.timeoutMs} 毫秒，条件一直没成立：${lastSeen}。`)
}

/** 轮询模型那条 CDP 会话的事件缓冲，等 after 之后第一条匹配 method 的事件；到期没等到抛 `TIMEOUT`。 */
export async function waitForProtocolEvent(
  options: BrowserProtocolEventWaitOptions
): Promise<BrowserProtocolEvent> {
  const startedAt = Date.now()
  let cursor = options.after
  while (Date.now() - startedAt <= options.timeoutMs) {
    options.abortSignal.throwIfAborted()
    const read = await options.readEvents({ method: options.method, after: cursor })
    const event = read.events.at(0)
    if (event) return event
    cursor = Math.max(cursor, read.last)
    await TimerScope.sleep(BrowserTuning.protocol.eventPollIntervalMs, {
      label: 'browser.waitForProtocolEvent',
      signal: options.abortSignal,
    })
  }
  throw new AppError(
    'TIMEOUT',
    `等了 ${options.timeoutMs} 毫秒，没有等到 ${options.method} 事件（从序号 ${options.after} 之后算起）。`
  )
}
