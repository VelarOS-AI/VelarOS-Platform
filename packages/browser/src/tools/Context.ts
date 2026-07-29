import { AppError } from '@velaros-ai/core/error'

import type { BrowserPendingEventKind } from '../core'
import { BrowserWorkspaceArtifactManager } from '../core'

import type { VelaTool } from './Types'

/** Browser 工具 execute 函数拿到的上下文类型。 */
type BrowserToolContext = Parameters<VelaTool<Record<string, never>>['execute']>[1]

/**
 * 只在实时快照确认存在 pending 事件时暴露对应处理工具。
 *
 * 处理器不是普通浏览器动作：常驻会诱导模型在每次页面操作前先探测权限、弹窗或下载。
 * 快照缺失时保持隐藏，调用方仍可用 browser_wait_for_pending_event 等待预期事件出现。
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
      '当前还没有激活浏览器网站工作区，请先调用 enter_browser_site。'
    )
  }
}

/**
 * 创建当前 browser 工作区的 artifact manager。
 *
 * manager 只通过 ToolBrowserApi 读写文件，因此天然被限制在当前站点的私有目录中。
 */
export function createArtifactManager(ctx: BrowserToolContext): BrowserWorkspaceArtifactManager {
  requireActiveBrowserSite(ctx)

  // 用 browser 文件 API 适配 artifact manager，避免它直接依赖 workspace/root 路径。
  return new BrowserWorkspaceArtifactManager({
    readFile: (path, startLine, endLine, maxChars) =>
      ctx.browser.readFile(path, startLine, endLine, maxChars),
    writeFile: (path, content, options) => ctx.browser.writeFile(path, content, options),
    listFiles: (options) => ctx.browser.listFiles(options),
  })
}

/** 读取当前激活的 BrowserSiteContext；未激活时抛出用户可读错误。 */
export function getActiveBrowserContext(ctx: BrowserToolContext) {
  requireActiveBrowserSite(ctx)
  // isActive() 与 getContext() 共享同一 session 状态；激活后 context 必定存在。
  return ctx.browser.getContext()!
}
