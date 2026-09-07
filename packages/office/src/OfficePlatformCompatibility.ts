import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isEmpty } from '@velaros-ai/core'

export function getRelativePathInsideOfficeRoot(
  rootPath: string,
  candidatePath: string
): Nullable<string> {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath))
  const inside =
    isEmpty(relativePath)
    || relativePath === '.'
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  return inside ? relativePath || '.' : null
}

export class OfficePlatformCompatibility {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`
  }

  public quoteShellPath(value: string): string {
    return this.quoteShellArg(this.platform === 'win32' ? value.replace(/\\/g, '/') : value)
  }
}

/** 当前进程使用的 Office 平台原语。 */
export const officePlatformCompatibility = new OfficePlatformCompatibility()
