import { KernelErrorCodes } from '../contract/constants'
import type {
  SemanticVersion,
  SemanticVersionComparator,
  SemanticVersionRange,
} from '../types/runtime'

import { KernelError } from './errors'

const SemanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/** 读取严格 SemVer；核心数字必须精确，数字预发布标识不能带前导零。 */
function readSemanticVersion(source: string): SemanticVersion | undefined {
  if (source.trim() !== source) return undefined
  const match = SemanticVersionPattern.exec(source)
  if (!match) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined
  if (match[4]?.split('.').some((identifier) => /^0\d+$/u.test(identifier))) return undefined
  return { major, minor, patch, prerelease: match[4], build: match[5] }
}

/** 解析失败携带完整原输入，调用方可按错误码翻译领域说法。 */
function invalidSemanticVersion(kind: 'version' | 'range', source: string): KernelError {
  return new KernelError(
    kind === 'version' ? KernelErrorCodes.invalidVersion : KernelErrorCodes.invalidVersionRange,
    kind === 'version' ? `无效的语义化版本 "${source}"` : `无效的语义化版本范围 "${source}"`,
    { source }
  )
}

/** 解析严格 major.minor.patch[-prerelease][+build]，不接受前导 v 或外侧空白。 */
export function parseSemanticVersion(source: string): SemanticVersion {
  const version = readSemanticVersion(source)
  if (!version) throw invalidSemanticVersion('version', source)
  return version
}

/** 使用同一解析口径判断版本是否合法，不抛错。 */
export function isSemanticVersion(source: string): boolean {
  return readSemanticVersion(source) !== undefined
}

/** 按 SemVer §11 比较预发布标识；长数字直接比较位数与字典序，不转浮点数。 */
function comparePrereleaseIdentifier(left: string, right: string): number {
  if (left === right) return 0
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric && left.length !== right.length) return left.length - right.length
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : 1
}

/** SemVer §11：预发布逐段比较，正式版在同核心版本之后；build 不参与排序。 */
function compareParsedSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === undefined) return 1
  if (right.prerelease === undefined) return -1
  const leftIdentifiers = left.prerelease.split('.')
  const rightIdentifiers = right.prerelease.split('.')
  for (
    let index = 0;
    index < Math.min(leftIdentifiers.length, rightIdentifiers.length);
    index += 1
  ) {
    const comparison = comparePrereleaseIdentifier(
      leftIdentifiers[index]!,
      rightIdentifiers[index]!
    )
    if (comparison !== 0) return comparison
  }
  return leftIdentifiers.length - rightIdentifiers.length
}

/** 比较两个版本号字符串，解析不了就携带实际失败参数抛错。 */
export function compareSemanticVersions(left: string, right: string): number {
  return compareParsedSemanticVersions(parseSemanticVersion(left), parseSemanticVersion(right))
}

/** 完整解析全部分句；不能让匹配短路跳过后面的非法作者输入。 */
function readSemanticVersionRange(source?: string): SemanticVersionRange | undefined {
  if (source === undefined) return [[]]
  const clauses: SemanticVersionComparator[][] = []
  for (const clause of source.split('||')) {
    const normalized = clause.trim()
    if (!normalized) return undefined
    const comparators: SemanticVersionComparator[] = []
    for (const token of normalized.split(/\s+/u)) {
      if (token === '*') continue
      const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(token)
      if (!match) return undefined
      const version = readSemanticVersion(match[2]!)
      if (!version) return undefined
      comparators.push({
        operator: (match[1] ?? '=') as SemanticVersionComparator['operator'],
        version,
      })
    }
    clauses.push(comparators)
  }
  return clauses
}

/** 解析 exact、*、^、~、比较符交集与 ||；缺席表示任意，显式空值拒绝。 */
export function parseSemanticVersionRange(source?: string): SemanticVersionRange {
  const range = readSemanticVersionRange(source)
  if (!range) throw invalidSemanticVersion('range', source!)
  return range
}

/** 清单边界使用同一范围解析口径，不以某个试探版本的匹配结果代替语法校验。 */
export function isSemanticVersionRange(source: string): boolean {
  return readSemanticVersionRange(source) !== undefined
}

/** 匹配已经解析的比较子句，不重复解析版本或生成会溢出的上界数字。 */
function satisfiesComparator(
  version: SemanticVersion,
  comparator: SemanticVersionComparator
): boolean {
  const lower = comparator.version
  const comparison = compareParsedSemanticVersions(version, lower)
  switch (comparator.operator) {
    case '>':
      return comparison > 0
    case '>=':
      return comparison >= 0
    case '<':
      return comparison < 0
    case '<=':
      return comparison <= 0
    case '^':
      return (
        comparison >= 0 &&
        version.major === lower.major &&
        (lower.major > 0 ||
          (version.minor === lower.minor && (lower.minor > 0 || version.patch === lower.patch)))
      )
    case '~':
      return comparison >= 0 && version.major === lower.major && version.minor === lower.minor
    default:
      return comparison === 0
  }
}

/** 消费已经完整解析的范围；备选分句之间取并集，分句内部取交集。 */
export function matchesSemanticVersionRange(
  version: SemanticVersion,
  range: SemanticVersionRange
): boolean {
  return range.some((clause) =>
    clause.every((comparator) => satisfiesComparator(version, comparator))
  )
}

/** 版本和范围各解析一次后匹配；任何非法尾项均会在匹配之前拒绝。 */
export function satisfiesSemanticVersionRange(version: string, range?: string): boolean {
  return matchesSemanticVersionRange(
    parseSemanticVersion(version),
    parseSemanticVersionRange(range)
  )
}
