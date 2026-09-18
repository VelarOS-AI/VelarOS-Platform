/** 路径判定：一条相对路径在不在根里、绝对路径怎么安全地转成根内相对路径、怎么写成可移植的分隔形式。 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isEmpty } from '@velaros-ai/core'

import type { KnowledgePathPlatform } from '../types/ingestion.js'

/** 当前进程的路径原语；测试可以传一份别的平台语义进来。 */
const DefaultPathPlatform: KnowledgePathPlatform = {
  isAbsolute,
  relative,
  resolve,
  sep,
}

/** 这条相对路径是不是还在根里面（`..` 开头或绝对路径都算逃出去了）。 */
export function isRelativePathInsideRoot(
  relativePath: string,
  platform: KnowledgePathPlatform = DefaultPathPlatform
): boolean {
  return (
    isEmpty(relativePath) ||
    relativePath === '.' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${platform.sep}`) &&
      !platform.isAbsolute(relativePath))
  )
}

/** 把一个候选路径转成根内相对路径；逃出根就返回 null。 */
export function getRelativePathInsideRoot(
  rootPath: string,
  candidatePath: string,
  platform: KnowledgePathPlatform = DefaultPathPlatform
): Nullable<string> {
  const relativePath = platform.relative(
    platform.resolve(rootPath),
    platform.resolve(candidatePath)
  )
  return isRelativePathInsideRoot(relativePath, platform) ? relativePath || '.' : null
}

/** 把路径里的反斜杠统一成正斜杠，跨平台存同一个字符串。 */
export function toPortablePathText(path: string): string {
  return path.replace(/\\/g, '/')
}

/** 把一条平台相对路径转成可移植写法。 */
export function toPortableRelativePath(
  relativePath: string,
  platform: KnowledgePathPlatform = DefaultPathPlatform
): string {
  return toPortablePathText(relativePath.split(platform.sep).join('/'))
}
