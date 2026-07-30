import { isAbsolute, relative, resolve, sep } from 'node:path'

export function getRelativePathInsideOfficeRoot(
  rootPath: string,
  candidatePath: string
): string | null {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath))
  const inside =
    relativePath === ''
    || relativePath === '.'
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  return inside ? relativePath || '.' : null
}

export class OfficePlatformCompatibility {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public quoteShellArg(value: string): string {
    return this.platform === 'win32'
      ? `"${value.replace(/"/g, '""')}"`
      : `'${value.replace(/'/g, "'\\''")}'`
  }
}

/**
 * Compatibility helper bound to the current process platform.
 *
 * @deprecated Construct `OfficePlatformCompatibility` at the host boundary.
 */
export const officePlatformCompatibility = new OfficePlatformCompatibility()
