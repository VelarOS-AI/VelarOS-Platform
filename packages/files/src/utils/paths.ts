/**
 * 路径：一批文件里判重用的身份键。
 */

import * as path from 'node:path'

/** 文件的身份键：解开符号链接后的真实路径规整成可比较的形式；Windows 与 macOS 的卷缺省不区分大小写，统一小写。 */
export function fileIdentity(target: string, platform: string): string {
  const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(target)
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved
}
