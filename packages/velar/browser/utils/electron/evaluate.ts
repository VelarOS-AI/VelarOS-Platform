import type electron from 'electron'

import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { BrowserEvaluateDeadlineOptions } from '../../types/electron.js'
import { BrowserTuning } from '../tuning'

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
  const timeoutMs = options.timeoutMs ?? BrowserTuning.page.evaluateDeadlineMs
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
