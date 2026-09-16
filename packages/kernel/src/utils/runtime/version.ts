// 宿主侧的语义化版本判定：口径来自 `utils/semver.ts`，这里只负责把中立的解析失败翻译成
// `KernelHostError`。
//
// 曾经这里自带一份实现，比较时**忽略预发布**，于是 `1.0.0-beta.1` 被判为满足 `>=1.0.0`，
// 而同一个包里的更新器判不满足；它也不认 `+build`，而 mod 信封照收——同一个版本号在两个关口
// 得到两种结论。
import { KernelHostError } from '../errors'
import {
  parseSemanticVersion,
  satisfiesSemanticVersionRange,
  SemanticVersionError,
} from '../semver'

function toHostError(error: unknown): unknown {
  if (!(error instanceof SemanticVersionError)) return error
  return new KernelHostError(
    error.kind === 'version' ? 'INVALID_VERSION' : 'INVALID_VERSION_RANGE',
    error.message,
  )
}

/**
 * Small deterministic semver matcher for module manifests.
 *
 * Supported forms are exact versions, `*`, caret, tilde, comparator
 * intersections, and `||` alternatives.
 */
export function satisfiesVersionRange(
  versionSource: string,
  rangeSource?: string,
): boolean {
  try {
    return satisfiesSemanticVersionRange(versionSource, rangeSource)
  } catch (error) {
    throw toHostError(error)
  }
}

export function assertSemanticVersion(version: string): void {
  try {
    parseSemanticVersion(version)
  } catch (error) {
    throw toHostError(error)
  }
}
