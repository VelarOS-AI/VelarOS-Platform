/**
 * 时间线上的引用怎么写、怎么读：调用 `C14`、步骤 `C14.2`、脚本 `lib/x.js`（最新版）与 `lib/x.js@3`、现在 `now`；
 * 以及脚本库的路径规矩和相对 import 怎么落到库里的路径。都不碰实例状态。
 */

import { posix } from 'node:path'

import { isNull, isString, isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'
import type { TimelineRef } from '../types/timeline.js'

/** 调用号：`C14`。 */
const CallRefPattern = /^C(\d+)$/u

/** 步骤号：`C14.2`。 */
const StepRefPattern = /^C(\d+)\.(\d+)$/u

/** 带版本的脚本：`lib/x.js@3`。 */
const VersionRefPattern = /^(.+)@(\d+)$/u

/** 脚本库路径的一段：字母、数字、下划线开头，后面可以有点和连字符；不许以点开头（也就没有 `.`、`..`）。 */
const ScriptPathSegmentPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u

/** 调用号写成 `C14`。 */
export function callRef(call: number): string {
  return `C${call}`
}

/** 步骤号写成 `C14.2`。 */
export function stepRef(call: number, step: number): string {
  return `C${call}.${step}`
}

/** 一版脚本写成 `lib/x.js@3`。 */
export function versionRef(path: string, version: number): string {
  return `${path}@${version}`
}

/**
 * 脚本库路径合不合规矩；合规返回 null，不合规返回给模型看的一句话。
 * 规矩：相对路径、用 `/` 分段、以 `.js` 结尾，每段以字母、数字或下划线开头。
 */
export function checkScriptPath(path: string): Nullable<string> {
  if (path.length > CodeSurfaceLimits.scriptPathChars) return `脚本路径最长 ${CodeSurfaceLimits.scriptPathChars} 个字符，${path.slice(0, 40)}… 太长了。`
  if (!path.endsWith('.js')) return `脚本路径要以 .js 结尾（比如 lib/changelog.js），${path} 不是。`
  if (!path.split('/').every((segment) => ScriptPathSegmentPattern.test(segment))) return `脚本路径 ${path} 不合规矩：用相对路径、/ 分段，每段以字母、数字或下划线开头（比如 lib/changelog.js）。`
  return null
}

/** 读一个引用；读不出来返回给模型看的一句话。 */
export function parseTimelineRef(text: string): TimelineRef | string {
  const trimmed = text.trim()
  if (trimmed === 'now') return { kind: 'now' }
  const step = StepRefPattern.exec(trimmed)
  if (step) return { kind: 'step', call: Number(step[1]), step: Number(step[2]) }
  const call = CallRefPattern.exec(trimmed)
  if (call) return { kind: 'call', call: Number(call[1]) }
  const versioned = VersionRefPattern.exec(trimmed)
  const path = versioned ? versioned[1] ?? '' : trimmed
  const invalid = checkScriptPath(path)
  if (!isNull(invalid)) return `认不出 ${trimmed}：引用写成调用 C14、步骤 C14.2、脚本 lib/x.js 或 lib/x.js@3（时间点还可以是 now）。${invalid}`
  return versioned ? { kind: 'script', path, version: Number(versioned[2]) } : { kind: 'script', path }
}

/** history 的 from、to：调用号的数字；没给是 undefined，写得不是调用号是 null。 */
export function parseCallBound(text: Optional<string>): Optional<Nullable<number>> {
  if (isUndefined(text)) return undefined
  const parsed = parseTimelineRef(text)
  return !isString(parsed) && parsed.kind === 'call' ? parsed.call : null
}

/** 是不是相对路径的 import（`./x.js`、`../lib/x.js`）：它们指向脚本库里的脚本。 */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/**
 * 相对 import 落到库里的哪个路径：从 importer 所在的目录算（直接跑的代码没有路径，从库根算）。
 * 走出库根、或者落下来的路径不合规矩时返回 null——检查器会报「找不到这个模块」。
 */
export function resolveLibraryImport(importer: Optional<string>, specifier: string): Nullable<string> {
  const base = isUndefined(importer) ? '.' : posix.dirname(importer)
  const joined = posix.normalize(posix.join(base, specifier))
  if (joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) return null
  return isNull(checkScriptPath(joined)) ? joined : null
}
