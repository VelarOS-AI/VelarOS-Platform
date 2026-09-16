import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { normalizeBrowserArtifactJsonPath } from '../../exports/core'

const log = logRuntime.tag('BrowserRecipePaths')

/** 校验并规范化 recipes/ 下的 JSON recipe 路径。 */
export function requireRecipePath(path: string): string {
  return normalizeBrowserArtifactJsonPath(
    path,
    'recipes',
    'recipe runner 只能读取当前网站工区 recipes/ 目录下的 JSON 文件。'
  )
}

/** 校验并规范化 pages/ 下的 JSON 页面快照路径。 */
export function requirePageSnapshotPath(path: string): string {
  return normalizeBrowserArtifactJsonPath(
    path,
    'pages',
    '只能读取当前网站工区 pages/ 目录下的 JSON 页面快照。'
  )
}

/** 校验并规范化 runs/ 下的 JSON 运行记录路径。 */
export function requireRunPath(path: string): string {
  return normalizeBrowserArtifactJsonPath(
    path,
    'runs',
    '只能读取当前网站工区 runs/ 目录下的 JSON 运行记录。'
  )
}

/** 判断两个 URL 是否属于同一 origin；URL 解析失败时退化为字符串相等。 */
export function isSameBrowserOrigin(leftUrl: string, rightUrl: string): boolean {
  try {
    return new URL(leftUrl).origin === new URL(rightUrl).origin
  } catch (error) {
    log.debug('解析浏览器 artifact URL origin 失败，退化为字符串比较', {
      leftUrl,
      rightUrl,
      error: String(error),
    })
    return leftUrl === rightUrl
  }
}

/** 确保 artifact 归属当前站点，拒绝跨网站复用 recipe/snapshot/run。 */
export function requireSameBrowserOrigin(artifactUrl: string, contextUrl: string, label: string): void {
  if (!isSameBrowserOrigin(artifactUrl, contextUrl)) {
    throw new AppError('VALIDATION', `${label} 不属于当前网站，已拒绝跨网站复用。`)
  }
}

