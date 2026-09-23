// 包内唯一的语义化版本口径。
//
// 这里原本有三份：宿主的模块依赖判定（比较时忽略预发布）、更新器（按 SemVer §11 排预发布）、
// mod 信封的校验正则（放行 `+build`）。三份口径不一的后果是同一个版本号在不同关口得到不同
// 结论——宿主判 `1.0.0-beta.1` 满足 `>=1.0.0`、更新器判不满足；信封接受 `1.0.0+build.1`、
// 宿主的清单校验当场拒绝。
//
// 现在以更新器那份为准（预发布低于正式版），并补上 build 元数据：`+build` 合法，且按 SemVer
// §10「比较时忽略 build」。本模块只抛带码的 {@link KernelError}（INVALID_VERSION /
// INVALID_VERSION_RANGE，原文在 `details.source`），各自的领域说法由调用方按码包一层。
import { isBlank, isEmpty, isNull, isUndefined } from '@velaros-ai/core'

import { KernelErrorCodes } from '../contract/constants'
import type { SemanticVersion } from '../types/runtime'

import { KernelError } from './errors'

export type { SemanticVersion } from '../types/runtime'

/** `major.minor.patch[-prerelease][+build]`，允许一个前导 `v`。 */
export const SemanticVersionPattern =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/** 版本号或版本范围解析不了：带码抛出，原文放在 `details.source`，调用方按码翻译成自己的说法。 */
function invalidSemanticVersion(kind: 'version' | 'range', source: string): KernelError {
  return new KernelError(
    kind === 'version' ? KernelErrorCodes.invalidVersion : KernelErrorCodes.invalidVersionRange,
    kind === 'version' ? `无效的语义化版本 "${source}"` : `无效的语义化版本范围 "${source}"`,
    { source }
  )
}

/** 解析一个语义化版本号；允许一个前导 `v`，解析不了就带码抛。 */
export function parseSemanticVersion(
  source: string,
  kind: 'version' | 'range' = 'version'
): SemanticVersion {
  const match = SemanticVersionPattern.exec(source.trim().replace(/^v/, ''))
  if (isNull(match)) throw invalidSemanticVersion(kind, source)
  // 三个捕获组都是 `\d+`，按构造就是数字；边界只解析一次，调用方直接信任结果。
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    build: match[5],
  }
}

/** 判断一个字符串是不是合法的语义化版本号，不抛错。 */
export function isSemanticVersion(source: string): boolean {
  return SemanticVersionPattern.test(source)
}

/** SemVer §11：预发布排在同一个正式版之前；build 元数据不参与比较。 */
export function compareParsedSemanticVersions(
  left: SemanticVersion,
  right: SemanticVersion
): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  if (left.prerelease === right.prerelease) return 0
  if (isUndefined(left.prerelease)) return 1
  if (isUndefined(right.prerelease)) return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

/** 比较两个版本号字符串，返回负数、0、正数；解析不了就带码抛。 */
export function compareSemanticVersions(left: string, right: string): number {
  return compareParsedSemanticVersions(parseSemanticVersion(left), parseSemanticVersion(right))
}

/**
 * 确定性范围匹配：精确版本、`*`、caret、tilde、比较符交集与 `||` 备选。
 *
 * 刻意不引第三方 semver：范围串必须在每台宿主上得到同一个结论，不受某个依赖的小版本影响。
 */
export function satisfiesSemanticVersionRange(version: string, range?: string): boolean {
  const parsed = parseSemanticVersion(version)
  if (isUndefined(range) || isBlank(range.trim())) return true
  return range.split('||').some((clause) => satisfiesClause(parsed, clause))
}

/** 判断一个版本满不满足一个 `||` 分句（分句内的比较符之间是交集）。 */
function satisfiesClause(version: SemanticVersion, clause: string): boolean {
  const normalized = clause.trim()
  if (isEmpty(normalized) || normalized === '*') return true
  if (normalized.startsWith('^')) return satisfiesCaret(version, normalized.slice(1))
  if (normalized.startsWith('~')) return satisfiesTilde(version, normalized.slice(1))
  return normalized.split(/\s+/).every((comparator) => satisfiesComparator(version, comparator))
}

/** 判断一个版本满不满足单个比较符（`>=`、`<`、`=` 等）。 */
function satisfiesComparator(version: SemanticVersion, comparator: string): boolean {
  const trimmed = comparator.trim()
  const operators = ['>=', '<=', '>', '<', '='] as const
  const operator = operators.find((candidate) => trimmed.startsWith(candidate))
  const versionText = trimmed.slice(operator?.length ?? 0).trim()
  if (isEmpty(versionText)) throw invalidSemanticVersion('range', comparator)
  const comparison = compareParsedSemanticVersions(
    version,
    parseSemanticVersion(versionText, 'range')
  )
  switch (operator ?? '=') {
    case '>':
      return comparison > 0
    case '>=':
      return comparison >= 0
    case '<':
      return comparison < 0
    case '<=':
      return comparison <= 0
    default:
      return comparison === 0
  }
}

/** caret 范围：不改最左边那位非零数字。 */
function satisfiesCaret(version: SemanticVersion, source: string): boolean {
  const lower = parseSemanticVersion(source, 'range')
  const upper: SemanticVersion =
    lower.major > 0
      ? { major: lower.major + 1, minor: 0, patch: 0 }
      : lower.minor > 0
        ? { major: 0, minor: lower.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: lower.patch + 1 }
  return (
    compareParsedSemanticVersions(version, lower) >= 0 &&
    compareParsedSemanticVersions(version, upper) < 0
  )
}

/** tilde 范围：允许 patch 位往上走。 */
function satisfiesTilde(version: SemanticVersion, source: string): boolean {
  const lower = parseSemanticVersion(source, 'range')
  const upper: SemanticVersion = {
    major: lower.major,
    minor: lower.minor + 1,
    patch: 0,
  }
  return (
    compareParsedSemanticVersions(version, lower) >= 0 &&
    compareParsedSemanticVersions(version, upper) < 0
  )
}
