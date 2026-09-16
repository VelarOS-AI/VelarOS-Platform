import { AppError } from '@velaros-ai/core/error'

import type { ToolContext } from '../contract/requires.js'
import type { BrowserWorkspaceArtifactFormat } from '../types/browser.js'
import type { BrowserPageContentFormat } from '../types/tools.js'
import type { BrowserWorkspaceArtifactAccess } from '../types/workspace.js'

/**
 * 用工具上下文里的浏览器文件 API 拼出产物管理器要的三个口子。
 *
 * 产物管理器只经这三个口子读写，所以天然被限制在当前站点的私有目录里，不认绝对路径。
 */
export function buildBrowserArtifactAccess(ctx: ToolContext): BrowserWorkspaceArtifactAccess {
  return {
    readFile: (path, startLine, endLine, maxChars) =>
      ctx.browser.readFile(path, startLine, endLine, maxChars),
    writeFile: (path, content, options) => ctx.browser.writeFile(path, content, options),
    listFiles: (options) => ctx.browser.listFiles(options),
  }
}

/** 正文格式到 extract 产物格式（决定 .txt / .md / .html 扩展名）的映射。 */
export const BrowserPageContentArtifactFormats: Record<BrowserPageContentFormat, BrowserWorkspaceArtifactFormat> = {
  plain: 'text',
  markdown: 'markdown',
  html: 'html',
}

/**
 * 站点工作区产物路径（recipes/、pages/、runs/ 下的 JSON）的**唯一规则**。
 *
 * 曾经有两套：工具侧拒绝任何含 `..` 的文件名（`recipes/a..b.json` 被误拒）、不认反斜杠；
 * Desktop 面板用的预览先把反斜杠换成 `/` 再按路径段判断——同一个文件面板能预览、工具读不了，
 * 或者反过来。合成一份后口径是：
 *
 * - 反斜杠一律当分隔符（Windows 写法照收）；
 * - `..` 只在**整段**是 `..` 时算穿越，文件名里的 `..` 不受影响；
 * - 首段必须是指定目录，且必须有文件名；
 * - 扩展名必须是 `.json`。
 */
export function normalizeBrowserArtifactJsonPath(
  path: string,
  directory: string,
  message: string
): string {
  const normalizedPath = path
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/+$/u, '')
    .replace(/^\/+/u, '')
  const segments = normalizedPath.split('/')

  if (
    segments.length < 2 ||
    segments[0] !== directory ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    !normalizedPath.endsWith('.json')
  ) {
    throw new AppError('VALIDATION', message, undefined, { path })
  }

  return segments.join('/')
}

/** 规范化 recipes/ 下的 JSON recipe 路径（宿主面板预览与 recipe 工具同一份规则）。 */
export function normalizeBrowserRecipePath(path: string): string {
  return normalizeBrowserArtifactJsonPath(
    path,
    'recipes',
    '只能读取当前网站工区 recipes/ 目录下的 JSON recipe。'
  )
}
