/** CDP 截图引擎里用不着实例状态的那部分：截图区域与产物路径的计算。 */

import { isObject } from '@velaros-ai/core'

import type { BrowserCaptureScreenshotOptions, BrowserScreenshotCaptureRegion, BrowserScreenshotMetadata } from '../../types/browser.js'
import type { BrowserPageDriverScreenshotOptions } from '../../types/driver'
import type { BrowserWorkspacePath } from '../../types/workspace.js'
import { resolveBrowserWorkspacePath } from '../workspace-paths'

/** 把这次实际截到的区域写回截图元数据。 */
export function applyCaptureRegionToMetadata(
  metadata: BrowserScreenshotMetadata,
  capture: BrowserScreenshotCaptureRegion
): BrowserScreenshotMetadata {
  return {
    ...metadata,
    documentWidth: capture.documentWidth || metadata.documentWidth,
    documentHeight: capture.documentHeight || metadata.documentHeight,
  }
}

/** 把公开的截图选项翻成页面驱动那一层要的选项。 */
export function resolveScreenshotOptions(
  metadata: BrowserScreenshotMetadata,
  options: BrowserCaptureScreenshotOptions
): BrowserPageDriverScreenshotOptions {
  if (options.region && isObject(options.region) && 'width' in options.region) {
    const region = options.region as { x?: number; y?: number; width?: number; height?: number }
    return {
      mode: 'region',
      metadata,
      clip: {
        x: Math.max(0, Math.round(region.x ?? 0)),
        y: Math.max(0, Math.round(region.y ?? 0)),
        width: Math.max(1, Math.round(region.width ?? metadata.viewportWidth)),
        height: Math.max(1, Math.round(region.height ?? metadata.viewportHeight)),
      },
    }
  }

  if (options.fullPage) return {
      mode: 'full-page',
      metadata,
    }

  return {
    mode: 'viewport',
    metadata,
  }
}

/** 解析截图落盘路径：与站点工作区的其它落盘同一份判定（按真实路径，解开符号链接）。 */
export async function resolveScreenshotPath(
  workspaceRoot: string,
  requestedPath?: string
): Promise<BrowserWorkspacePath> {
  const relativePath =
    requestedPath?.trim() ||
    `artifacts/screenshots/browser-${new Date().toISOString().replace(/[:.]/g, '-')}.png`

  return resolveBrowserWorkspacePath(workspaceRoot, relativePath, '截图路径')
}
