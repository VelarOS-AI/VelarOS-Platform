import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isEmpty, isNotNull } from '@velaros-ai/core'

export interface ProjectPathPlatform {
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  sep: string
}

const defaultPlatform: ProjectPathPlatform = { isAbsolute, relative, resolve, sep }

export function getRelativePathInsideProjectRoot(
  rootPath: string,
  candidatePath: string,
  platform: ProjectPathPlatform = defaultPlatform
): Nullable<string> {
  const relativePath = platform.relative(platform.resolve(rootPath), platform.resolve(candidatePath))
  const inside =
    isEmpty(relativePath)
    || relativePath === '.'
    || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${platform.sep}`)
      && !platform.isAbsolute(relativePath)
    )
  return inside ? relativePath || '.' : null
}

export function isPathInsideProjectRoot(
  rootPath: string,
  candidatePath: string,
  platform?: ProjectPathPlatform
): boolean {
  return isNotNull(getRelativePathInsideProjectRoot(rootPath, candidatePath, platform))
}

export function toPortableProjectRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}
