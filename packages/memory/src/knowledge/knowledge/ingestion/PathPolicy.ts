import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isEmpty } from '@velaros-ai/core'

export interface KnowledgePathPlatform {
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  sep: string
}

const DefaultPathPlatform: KnowledgePathPlatform = {
  isAbsolute,
  relative,
  resolve,
  sep,
}

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

export function toPortablePathText(path: string): string {
  return path.replace(/\\/g, '/')
}

export function toPortableRelativePath(
  relativePath: string,
  platform: KnowledgePathPlatform = DefaultPathPlatform
): string {
  return toPortablePathText(relativePath.split(platform.sep).join('/'))
}
