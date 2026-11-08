// 更新器侧的语义化版本判定：口径来自 `utils/semver.ts`，这里只负责把带码的解析失败翻译成
// 更新器自己的说法（`KernelUpdaterError`，带上更新器关心的 details）。
import { KernelErrorCodes, KernelUpdaterErrorCodes } from '../../contract/constants'
import type { SemanticVersionRange } from '../../types/runtime'
import type { KernelSemanticVersion } from '../../types/updater'
import { KernelError, KernelUpdaterError } from '../errors'
import {
  compareSemanticVersions,
  isSemanticVersion,
  matchesSemanticVersionRange,
  parseSemanticVersion,
  parseSemanticVersionRange,
} from '../semver'

export type { KernelSemanticVersion } from '../../types/updater'
/** 把 semver 的带码失败翻成更新器的说法；不是版本失败就原样抛回去。 */
function toUpdaterError(error: unknown, source: string): unknown {
  if (!(error instanceof KernelError)) return error
  const actualSource = error.details.source ?? source
  if (error.code === KernelErrorCodes.invalidVersion)
    return new KernelUpdaterError(
      KernelUpdaterErrorCodes.invalidVersion,
      `内核版本号 "${actualSource}" 不合法`,
      { version: actualSource }
    )
  if (error.code === KernelErrorCodes.invalidVersionRange)
    return new KernelUpdaterError(
      KernelUpdaterErrorCodes.invalidVersionRange,
      `内核版本范围 "${actualSource}" 不合法`,
      { versionRange: actualSource }
    )
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

/** 先完整解析更新查询的版本范围，失败保留更新器的领域错误。 */
export function parseKernelVersionRange(source?: string): SemanticVersionRange {
  try {
    return parseSemanticVersionRange(source)
  } catch (error) {
    throw toUpdaterError(error, source ?? '')
  }
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
export function satisfiesKernelVersionRange(version: string, range?: string): boolean {
  return matchesSemanticVersionRange(parseKernelVersion(version), parseKernelVersionRange(range))
}
