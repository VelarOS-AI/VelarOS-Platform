import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserUserActivityItem } from '../types/session.js'
import type { BrowserSessionActionOptions, BrowserSessionQueueSlot } from '../types/session.js'

import { BrowserTuning } from './tuning'

/** 把一条用户活动拼成一句人能看懂的摘要。 */
export function formatSummaryItem(item: BrowserUserActivityItem): string {
  const suffix = item.url ? `（${item.url}）` : ''
  const detail = item.detail ? `：${item.detail}` : ''

  switch (item.kind) {
    case 'click':
      return `- 用户在浏览器中点击页面${suffix}${detail}。`
    case 'keyboard':
      return `- 用户在浏览器中使用键盘${suffix}${detail}。`
    case 'scroll':
      return `- 用户在浏览器中滚动页面${suffix}${detail}。`
    case 'input':
      return `- 用户在浏览器中输入内容，文本未记录${suffix}${detail}。`
    case 'navigation':
      return `- 用户在浏览器中导航到 ${item.url ?? '新页面'}${detail}。`
    case 'dialog':
      return `- 用户触发或处理了浏览器弹窗${suffix}${detail}。`
    case 'download':
      return `- 用户触发或处理了浏览器下载${suffix}${detail}。`
    case 'permission':
      return `- 用户触发或处理了浏览器权限请求${suffix}${detail}。`
    case 'focus':
      return `- 用户聚焦了浏览器页面${suffix}${detail}。`
    case 'unknown':
      return `- 用户操作了浏览器页面${suffix}${detail}。`
  }
}

/** 没人处理弹窗时的缺省结算：confirm/prompt 按取消。 */
export function defaultDialogResponse(type: string): { accept: boolean; promptText: string } {
  return {
    accept: type === 'alert',
    promptText: '',
  }
}

/** 在挂起事件表里找一条：给了 eventId 就按 id 找，没给就取最早的那条。 */
export function findPendingEntry<T extends { id: string; sessionId: string }>(
  store: Map<string, T>,
  sessionId: string,
  eventId?: string
): T | undefined {
  if (eventId) {
    const entry = store.get(eventId)
    return entry?.sessionId === sessionId ? entry : undefined
  }

  for (const entry of store.values()) {
    if (entry.sessionId === sessionId) return entry
  }

  return undefined
}

/**
 * 等前一个名额，**同时听中止信号**。
 *
 * 上一版没有这一格，于是 `abortSignal?.throwIfAborted()` 全写在排队闭包**内部**——
 * 队头死结时闭包永远不被调度，信号永远没人检查，中止对卡住的会话完全无效。
 */
export async function awaitTurn(previous: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  // @arch-guard:suspend code-style/forbid-swallowed-errors 理由：同 run()——等的是**前驱**的名额，前驱的错误归它自己的调用方；这里只关心「轮到我了没有」，成败无关。
  const settled = previous.catch(() => undefined)
  if (!signal) {
    await settled
    return
  }
  signal.throwIfAborted()

  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new AppError('CANCELLED', '浏览器会话动作已取消。'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([settled, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** 调用方等待有界；实际动作未收束时继续持有独占名额，由队列隔离会话。 */
export async function runWithHoldCap<T>(
  slot: BrowserSessionQueueSlot,
  action: () => Promise<T>,
  options: BrowserSessionActionOptions
): Promise<T> {
  const holdCapMs = options.holdCapMs ?? BrowserTuning.session.actionHoldCapMs
  const label = options.label ?? 'browser-session-action'
  const timers = new TimerScope({ name: 'BrowserSessionActionQueue' })
  try {
    const running = Promise.resolve()
      .then(action)
      .finally(() => slot.release())
    return await timers.withTimeout(holdCapMs, () => running, {
      label,
      timeoutMessage: `浏览器会话动作 ${label} 超过 ${holdCapMs}ms 未返回。`,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new AppError(
        'TIMEOUT',
        `浏览器页面在 ${holdCapMs}ms 内没有响应 ${label}：页面可能已崩溃或被脚本卡死。` +
          '动作可能仍在运行，当前会话已隔离；可关闭页面，使用新会话继续，旧动作收束后原会话才恢复。',
        error
      )
    }
    throw error
  } finally {
    timers.dispose()
  }
}

/** 排在上一件事后面跑这一件，并给它在队列里的独占时间封顶。 */
export async function executeInTurn<T>(
  previous: Promise<unknown>,
  slot: BrowserSessionQueueSlot,
  action: () => Promise<T>,
  options: BrowserSessionActionOptions
): Promise<T> {
  try {
    await awaitTurn(previous, options.signal)
    options.signal?.throwIfAborted()
  } catch (error) {
    // 没轮到就被中止：立刻退出排队。不放名额的话，一次中止会让整条队伍陪着它一起等。
    slot.release()
    throw error
  }
  return runWithHoldCap(slot, action, options)
}

/** 造一个排队名额：`release()` 放出名额，`released` 在放出时结算，后一个动作等的就是它。 */
export function createQueueSlot(): BrowserSessionQueueSlot {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return { released, release }
}
