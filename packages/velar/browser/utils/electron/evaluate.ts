import type electron from 'electron'

import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { BrowserErrorCodes } from '../../contract/constants.js'
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
  if (webContents.isDestroyed()) {
    throw new AppError('VALIDATION', '页面已销毁，无法在其中求值。')
  }
  return runWithEvaluateDeadline(() => webContents.executeJavaScript(script, userGesture) as Promise<T>, options)
}

/**
 * 在内嵌页面的一个框架里求值（frameId 是 `frameTreeNodeId`，取自 `listWebContentsFrames`）：顶层框架走 `evaluateInWebContents`，
 * 跨源 iframe 也能进；框架已经不在了（页面跳转之后旧 id 作废）抛 `BROWSER_FRAME_NOT_FOUND`。期限与顶层求值一样。
 */
export async function evaluateInFrame<T>(
  webContents: electron.WebContents,
  frameId: string,
  script: string,
  userGesture = false,
  options: BrowserEvaluateDeadlineOptions = {}
): Promise<T> {
  if (webContents.isDestroyed()) {
    throw new AppError('VALIDATION', '页面已销毁，无法在其中求值。')
  }
  const frame = webContents.mainFrame.framesInSubtree.find((candidate) => String(candidate.frameTreeNodeId) === frameId)
  if (!frame) {
    throw new AppError(BrowserErrorCodes.frameNotFound, `框架 ${frameId} 不在当前页面的框架树里（页面跳转之后旧 id 作废）：重新 frames()。`)
  }
  if (frame === webContents.mainFrame) return evaluateInWebContents<T>(webContents, script, userGesture, options)
  return runWithEvaluateDeadline(() => frame.executeJavaScript(script, userGesture) as Promise<T>, options)
}

/** 给一次求值套上主进程的期限：渲染进程不回话时收口成 `TIMEOUT`，不让 await 永远挂着。 */
async function runWithEvaluateDeadline<T>(run: () => Promise<T>, options: BrowserEvaluateDeadlineOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? BrowserTuning.page.evaluateDeadlineMs
  const label = options.label ?? 'page-evaluate'
  const timers = new TimerScope({ name: 'BrowserWebContentsEvaluator' })
  try {
    return await timers.withTimeout(timeoutMs, run, {
      label,
      timeoutMessage: `页面求值 ${label} 超过 ${timeoutMs}ms 未返回。`,
    })
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
