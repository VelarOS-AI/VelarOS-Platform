/**
 * 路径判定与资源定位的原语：包含判断、符号链接判断、PDF 标准字体的位置。
 *
 * 包含判断用公共件 `@velaros-ai/core/platform` 的 `isPathTextInside`（带分隔符边界，名字以 `..` 开头的目录照常算在里面），
 * 不自己写 `startsWith('..')`；真实路径由 `RendererPaths` 先算好再交给这里。
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { AppError, readErrnoCode } from '@velaros-ai/core'
import { currentPlatform } from '@velaros-ai/core/platform'

import { DocumentRendererErrorCodes } from '../contract/constants.js'

/** 真实路径是盘上的写法，按字面比大小写：同一个物理文件的别名不许绕过判定。 */
export function isPathInsideProjectRoot(projectRoot: string, target: string): boolean {
  return currentPlatform.isPathTextInside(target, projectRoot, { caseSensitive: true })
}

/** 越界当场拒绝，抛 PATH_DENIED；调用方把它收成回执，`label` 点名是哪一条路径。 */
export function assertPathInsideProjectRoot(projectRoot: string, target: string, label: string): void {
  if (isPathInsideProjectRoot(projectRoot, target)) return
  throw new AppError(DocumentRendererErrorCodes.pathDenied, `${label} 解析后落在 projectRoot 之外。`)
}

/** 这个路径本身是不是符号链接；路径还不存在时算不是。 */
export async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error) {
    if (readErrnoCode(error) === 'ENOENT') return false
    throw error
  }
}

/** PDF 标准字体所在的目录 URL：资源根由产品启动器用环境变量指定，没设就返回缺席值，交给 pdfjs 自己找。 */
export function pdfStandardFontDataUrl(): Optional<string> {
  const resourcesRoot = process.env.VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT?.trim()
  if (!resourcesRoot) return undefined
  return `${pathToFileURL(join(resourcesRoot, 'pdfjs-standard-fonts')).href}/`
}
