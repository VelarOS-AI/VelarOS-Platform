import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface BrowserPathPlatform {
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  sep: string
}

const defaultPlatform: BrowserPathPlatform = { isAbsolute, relative, resolve, sep }

export function getRelativePathInsideRoot(
  rootPath: string,
  candidatePath: string,
  platform: BrowserPathPlatform = defaultPlatform
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

export function toPortableRelativePath(
  relativePath: string,
  platform: BrowserPathPlatform = defaultPlatform
): string {
  return relativePath.split(platform.sep).join('/').replace(/\\/g, '/')
}
