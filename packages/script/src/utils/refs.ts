/** 程序附属模块的路径校验与相对 import 解析。 */
import { posix } from 'node:path'

import { isNull, isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'

/** 相对模块路径的一段；禁止上溯和隐藏段。 */
const ScriptPathSegmentPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u

/** 校验程序附属模块路径；通过时返回 null。 */
export function checkScriptPath(path: string): Nullable<string> {
  if (path.length > CodeSurfaceLimits.scriptPathChars)
    return `脚本路径最长 ${CodeSurfaceLimits.scriptPathChars} 个字符，${path.slice(0, 40)}… 太长了。`
  if (!path.endsWith('.js')) return `脚本路径要以 .js 结尾（比如 lib/changelog.js），${path} 不是。`
  if (!path.split('/').every((segment) => ScriptPathSegmentPattern.test(segment)))
    return `脚本路径 ${path} 不合规矩：用相对路径、/ 分段，每段以字母、数字或下划线开头（比如 lib/changelog.js）。`
  return null
}

/** 是不是相对路径的 import（`./x.js`、`../lib/x.js`）：它们指向脚本库里的脚本。 */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/**
 * 相对 import 落到库里的哪个路径：从 importer 所在的目录算（直接跑的代码没有路径，从库根算）。
 * 走出库根、或者落下来的路径不合规矩时返回 null——检查器会报「找不到这个模块」。
 */
export function resolveLibraryImport(
  importer: Optional<string>,
  specifier: string
): Nullable<string> {
  const base = isUndefined(importer) ? '.' : posix.dirname(importer)
  const joined = posix.normalize(posix.join(base, specifier))
  if (joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) return null
  return isNull(checkScriptPath(joined)) ? joined : null
}
