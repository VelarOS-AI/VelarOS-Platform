import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface WorkspacePathPlatform {
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  sep: string
}

const defaultPlatform: WorkspacePathPlatform = { isAbsolute, relative, resolve, sep }

export function getRelativePathInsideWorkspaceRoot(
  rootPath: string,
  candidatePath: string,
  platform: WorkspacePathPlatform = defaultPlatform
): string | null {
  const relativePath = platform.relative(platform.resolve(rootPath), platform.resolve(candidatePath))
  const inside =
    relativePath === ''
    || relativePath === '.'
    || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${platform.sep}`)
      && !platform.isAbsolute(relativePath)
    )
  return inside ? relativePath || '.' : null
}

export function isPathInsideWorkspaceRoot(
  rootPath: string,
  candidatePath: string,
  platform?: WorkspacePathPlatform
): boolean {
  return getRelativePathInsideWorkspaceRoot(rootPath, candidatePath, platform) !== null
}

export function toPortableWorkspaceRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}
