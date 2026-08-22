import type electron from 'electron'

import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

/**
 * 主进程侧对 `webContents.executeJavaScript` 的**唯一上限**。
 *
 * ## 为什么页内超时不算数
 * 每个注入脚本自己都带一个 `Promise.race` 超时（`BrowserEvaluateScriptBuilder` 的
 * `payload.timeoutMs`、等待族的 60s 钳制）。那道超时跑在**渲染进程的事件循环上**：
 * 渲染进程被脚本同步卡死（例如页面脚本里的死循环）、或页面在求值途中导航走了，
 * 它就永远没有机会触发，而主进程这边的 promise **也永远不会 settle**——
 * Electron 不保证在这两种情形下 reject。
 *
 * 这正是 AGENT-12 那条 brick 的第一因：一个永不 settle 的求值占死会话串行队列，
 * 后续的 `presentPage` 14 分钟不被调度、abort 无效、只能重启应用。
 * **凡是等渲染进程回话的 await，上限必须由主进程自己拿着。**
 *
 * 90s 的判据：队列里最长的合法页内脚本是等待族（钳到 60s），加上注入与序列化余量。
 * 越过它只可能是渲染进程不会再回话了。
 */
const DefaultEvaluateDeadlineMs = 90_000

export interface BrowserEvaluateDeadlineOptions {
  /** 覆盖默认上限；页内脚本自带更长等待时才需要传。 */
  readonly timeoutMs?: number
  /** 超时正文里的调用名，用来把死结定位到具体路径。 */
  readonly label?: string
}

/**
 * 带主进程上限地在页面里求值。
 *
 * 超时后被求值的脚本仍留在渲染进程里（没有办法撤回一次 `executeJavaScript`），
 * 但**调用方拿到的是一个终态失败**，而不是一个永远不来的答案。
 */
export async function evaluateInWebContents<T>(
  webContents: electron.WebContents,
  script: string,
  userGesture = false,
  options: BrowserEvaluateDeadlineOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DefaultEvaluateDeadlineMs
  const label = options.label ?? 'page-evaluate'
  if (webContents.isDestroyed()) {
    throw new AppError('VALIDATION', '页面已销毁，无法在其中求值。')
  }

  const timers = new TimerScope({ name: 'BrowserWebContentsEvaluator' })
  try {
    return (await timers.withTimeout(
      timeoutMs,
      () => webContents.executeJavaScript(script, userGesture) as Promise<T>,
      {
        label,
        timeoutMessage: `页面求值 ${label} 超过 ${timeoutMs}ms 未返回。`,
      }
    )) as T
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new AppError(
        'TIMEOUT',
        `页面在 ${timeoutMs}ms 内没有响应求值（${label}）：渲染进程可能被脚本卡死，或页面已在求值途中导航离开。` +
          '这次求值没有结果；重新加载页面后再试。',
        error
      )
    }
    throw error
  } finally {
    timers.dispose()
  }
}
