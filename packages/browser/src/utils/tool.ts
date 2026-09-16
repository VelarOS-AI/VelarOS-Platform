import { AppError } from '@velaros-ai/core/error'
import { toolContracts } from '@velaros-ai/tool-contract'

import { BrowserSpaceId } from '../contract/constants.js'
import type { VelaTool } from '../contract/provides.js'
import type { BrowserToolContext } from '../contract/requires.js'
import type { BrowserPendingEventKind } from '../types/browser.js'
import type { DefineBrowserToolInput } from '../types/tools.js'

/**
 * 只在实时快照确认存在 pending 事件时暴露对应处理工具。
 *
 * 处理器不是普通浏览器动作：常驻会诱导模型在每次页面操作前先探测权限、弹窗或下载。
 * 快照缺失时保持隐藏，调用方仍可用 browser:wait_for_pending_event 等待预期事件出现。
 */
export function hasPendingBrowserEvent(
  ctx: BrowserToolContext,
  kind?: BrowserPendingEventKind
): boolean {
  if (!ctx.browser.isActive()) return false

  const pendingEvents = ctx.browser.getTurnContextSnapshot?.()?.pendingEvents
  if (!pendingEvents) return false

  return kind
    ? pendingEvents[kind] > 0
    : pendingEvents.dialog + pendingEvents.download + pendingEvents.permission > 0
}

/** 确保当前 session 已进入 browser site 模式。 */
export function requireActiveBrowserSite(ctx: BrowserToolContext): void {
  if (!ctx.browser.isActive()) {
    throw new AppError(
      'VALIDATION',
      '当前还没有激活浏览器网站工作区，请先调用 browser:enter_site。'
    )
  }
}

/** 读取当前激活的 BrowserSiteContext；未激活时抛出用户可读错误。 */
export function getActiveBrowserContext(ctx: BrowserToolContext) {
  requireActiveBrowserSite(ctx)
  // isActive() 与 getContext() 共享同一 session 状态；激活后 context 必定存在。
  return ctx.browser.getContext()!
}

/** 定义一个浏览器工具：补上 category，其余原样交给工具契约。 */
export const defineBrowserTool: <TInput extends Record<string, unknown>>(
  input: DefineBrowserToolInput<TInput>
) => VelaTool<TInput> = toolContracts.createDefiner<BrowserToolContext>({
  categoryOf: () => BrowserSpaceId,
})
