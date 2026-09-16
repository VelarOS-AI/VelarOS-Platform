// 宿主侧的语义化版本判定：口径来自 `utils/semver.ts`，这里只把版本解析失败补上宿主关心的说法。
//
// 曾经这里自带一份实现，比较时**忽略预发布**，于是 `1.0.0-beta.1` 被判为满足 `>=1.0.0`，
// 而同一个包里的更新器判不满足；它也不认 `+build`，而 mod 信封照收——同一个版本号在两个关口
// 得到两种结论。
import {
  parseSemanticVersion,
  satisfiesSemanticVersionRange,
} from '../semver'

/**
 * 判断一个版本号是否满足版本范围。
 *
 * 支持精确版本、`*`、caret、tilde、比较符交集与 `||` 并集；解析不了时抛带
 * INVALID_VERSION / INVALID_VERSION_RANGE 码的 KernelError。
 */
export function satisfiesVersionRange(
  versionSource: string,
  rangeSource?: string,
): boolean {
  return satisfiesSemanticVersionRange(versionSource, rangeSource)
}

/** 断言一个字符串是合法的语义化版本；不是就抛带 INVALID_VERSION 码的 KernelError。 */
export function assertSemanticVersion(version: string): void {
  parseSemanticVersion(version)
}
