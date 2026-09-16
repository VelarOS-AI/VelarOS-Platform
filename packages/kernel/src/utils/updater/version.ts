// 更新器侧的语义化版本判定：口径来自 `utils/semver.ts`，这里只负责把带码的解析失败翻译成
// 更新器自己的说法（`KernelUpdaterError`，带上更新器关心的 details）。
import { isString } from '@velaros-ai/core'

import { KernelErrorCodes, KernelUpdaterErrorCodes } from '../../contract/constants'
import { KernelError, KernelUpdaterError } from '../errors'
import {
  compareSemanticVersions,
  isSemanticVersion,
  parseSemanticVersion,
  satisfiesSemanticVersionRange,
  type SemanticVersion,
  SemanticVersionPattern,
} from '../semver'

/** 更新器面上的版本号形状，与包内唯一的语义化版本口径同构。 */
export type KernelSemanticVersion = SemanticVersion

/** 更新清单校验用的版本号正则，与包内唯一口径同一份。 */
export const KernelVersionPattern = SemanticVersionPattern

/** 把 semver 的带码失败翻成更新器的说法；不是版本失败就原样抛回去。 */
function toUpdaterError(error: unknown, source: string): unknown {
  if (!(error instanceof KernelError)) return error
  if (error.code === KernelErrorCodes.invalidVersion) return new KernelUpdaterError(
    KernelUpdaterErrorCodes.invalidVersion,
    `内核版本号 "${source}" 不合法`,
    { version: source },
  )
  if (error.code === KernelErrorCodes.invalidVersionRange) {
    const range = isString(error.details.source) ? error.details.source : source
    return new KernelUpdaterError(
      KernelUpdaterErrorCodes.invalidVersionRange,
      `内核版本范围 "${range}" 不合法`,
      { versionRange: range },
    )
  }
  return error
}

/** 解析一个内核版本号；不合法时抛更新器的 INVALID_VERSION。 */
export function parseKernelVersion(source: string): KernelSemanticVersion {
  try {
    return parseSemanticVersion(source)
  } catch (error) {
    throw toUpdaterError(error, source)
  }
}

/** 断言一个内核版本号合法。 */
export function assertKernelVersion(version: string): void {
  parseKernelVersion(version)
}

/** 判断一个字符串是不是合法的内核版本号（不抛错）。 */
export function isKernelVersion(version: string): boolean {
  return isSemanticVersion(version)
}

/** 比较两个内核版本号；预发布排在同名正式版之前（SemVer §11）。 */
export function compareKernelVersions(left: string, right: string): number {
  try {
    return compareSemanticVersions(left, right)
  } catch (error) {
    throw toUpdaterError(error, left)
  }
}

/**
 * 判断一个内核版本号是否满足版本范围。
 *
 * 覆盖精确版本、`*`、caret、tilde、比较符交集与 `||` 并集；内核自带这份匹配器是为了让同一个
 * 范围串在每台宿主上得到同一个结论，不引运行时依赖。
 */
export function satisfiesKernelVersionRange(
  version: string,
  range?: string,
): boolean {
  try {
    return satisfiesSemanticVersionRange(version, range)
  } catch (error) {
    throw toUpdaterError(error, version)
  }
}
