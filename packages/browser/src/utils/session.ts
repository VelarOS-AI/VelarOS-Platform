

import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserUserActivityItem } from '../types/browser.js'
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

/** 跑一个动作，并给它在会话队列里的独占时间封顶；到点放行队伍，动作本身仍挂着。 */
export async function runWithHoldCap<T>(
  slot: BrowserSessionQueueSlot,
  action: () => Promise<T>,
  options: BrowserSessionActionOptions
): Promise<T> {
  const holdCapMs = options.holdCapMs ?? BrowserTuning.session.actionHoldCapMs
  const label = options.label ?? 'browser-session-action'
  const timers = new TimerScope({ name: 'BrowserSessionActionQueue' })
  try {
    // 超时后动作本体仍挂在原地（没有办法强杀一个 Electron 的 executeJavaScript），
    // 但**名额会在 finally 里还回去**——队伍继续走，会话不再是死的。
    return await timers.withTimeout(holdCapMs, () => action(), {
      label,
      timeoutMessage: `浏览器会话动作 ${label} 超过 ${holdCapMs}ms 未返回，判定为死结并放行队列。`,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new AppError(
        'TIMEOUT',
        `浏览器页面在 ${holdCapMs}ms 内没有响应 ${label}：页面可能已崩溃或被脚本卡死。` +
          '这次操作没有结果，但会话已经放行，可以继续执行后续操作。',
        error
      )
    }
    throw error
  } finally {
    slot.release()
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
  } catch (error) {
    // 没轮到就被中止：立刻退出排队。不放名额的话，一次中止会让整条队伍陪着它一起等。
    slot.release()
    throw error
  }
  return runWithHoldCap(slot, action, options)
}

/**
 * 单个动作允许独占一条会话队列的上限 —— **最后一道网，不是主超时**。
 *
 * 判据取「任何一条合法动作都跑不到这么久」：队列里最长的合法动作是页内等待
 * （`waitForSelector` / `waitForPage` 各自钳到 60s）与 `presentPage` 那条
 * 「等导航稳定 30s + loadUrl 30s」的串联，都在 65s 上下。150s 之外只可能是**死结**。
 *
 * 存在的理由是一次 brick 级事故（AGENT-12）：`webContents.executeJavaScript` 在渲染进程
 * 被脚本卡死 / 页面正在导航走时**永不 settle**，它占住队头，后面所有动作——包括
 * 后续的 `presentPage`、包括清理用的 `closeSession`——全都排在死结后面，
 * 14 分钟不返回，abort 也救不回来（信号只在排队闭包**内部**被检查，闭包压根没被调度），
 * 只有重启应用。**一个永不 settle 的 promise 不许换来一条永久瘫痪的会话。**
 */

export function createQueueSlot(): BrowserSessionQueueSlot {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return { released, release }
}
