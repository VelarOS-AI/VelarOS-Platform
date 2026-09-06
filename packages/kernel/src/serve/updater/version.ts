import { isBlank, isEmpty,isNull, isUndefined } from '@velaros-ai/core';

import { KernelUpdaterError } from './errors'

export interface KernelSemanticVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease?: string
}

export const KernelVersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseKernelVersion(source: string): KernelSemanticVersion {
  const match = KernelVersionPattern.exec(source.trim().replace(/^v/, ''))
  if (isNull(match)) {
    throw new KernelUpdaterError(
      'INVALID_VERSION',
      `Invalid Kernel version "${source}"`,
      { version: source },
    )
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

export function assertKernelVersion(version: string): void {
  parseKernelVersion(version)
}

export function isKernelVersion(version: string): boolean {
  return KernelVersionPattern.test(version)
}

/** Prerelease builds sort below their release, matching SemVer §11. */
export function compareKernelVersions(left: string, right: string): number {
  const a = parseKernelVersion(left)
  const b = parseKernelVersion(right)
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prerelease === b.prerelease) return 0
  if (isUndefined(a.prerelease)) return 1
  if (isUndefined(b.prerelease)) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

function compareParsed(
  version: KernelSemanticVersion,
  target: KernelSemanticVersion,
): number {
  if (version.major !== target.major) return version.major - target.major
  if (version.minor !== target.minor) return version.minor - target.minor
  if (version.patch !== target.patch) return version.patch - target.patch
  if (version.prerelease === target.prerelease) return 0
  if (isUndefined(version.prerelease)) return 1
  if (isUndefined(target.prerelease)) return -1
  return version.prerelease < target.prerelease ? -1 : 1
}

function parseRangeVersion(source: string): KernelSemanticVersion {
  try {
    return parseKernelVersion(source)
  } catch {
    throw new KernelUpdaterError(
      'INVALID_VERSION_RANGE',
      `Invalid Kernel version range "${source}"`,
      { versionRange: source },
    )
  }
}

function satisfiesComparator(
  version: KernelSemanticVersion,
  comparator: string,
): boolean {
  const trimmed = comparator.trim()
  const operators = ['>=', '<=', '>', '<', '='] as const
  const operator = operators.find((candidate) => trimmed.startsWith(candidate))
  const versionText = trimmed.slice(operator?.length ?? 0).trim()
  if (!versionText) {
    throw new KernelUpdaterError(
      'INVALID_VERSION_RANGE',
      `Invalid Kernel version range comparator "${comparator}"`,
      { versionRange: comparator },
    )
  }
  const comparison = compareParsed(version, parseRangeVersion(versionText))
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

function satisfiesCaret(
  version: KernelSemanticVersion,
  source: string,
): boolean {
  const lower = parseRangeVersion(source)
  const upper: KernelSemanticVersion = lower.major > 0
    ? { major: lower.major + 1, minor: 0, patch: 0 }
    : lower.minor > 0
      ? { major: 0, minor: lower.minor + 1, patch: 0 }
      : { major: 0, minor: 0, patch: lower.patch + 1 }
  return compareParsed(version, lower) >= 0 && compareParsed(version, upper) < 0
}

function satisfiesTilde(
  version: KernelSemanticVersion,
  source: string,
): boolean {
  const lower = parseRangeVersion(source)
  const upper: KernelSemanticVersion = {
    major: lower.major,
    minor: lower.minor + 1,
    patch: 0,
  }
  return compareParsed(version, lower) >= 0 && compareParsed(version, upper) < 0
}

function satisfiesClause(
  version: KernelSemanticVersion,
  clause: string,
): boolean {
  const normalized = clause.trim()
  if (isEmpty(normalized) || normalized === '*') return true
  if (normalized.startsWith('^')) return satisfiesCaret(version, normalized.slice(1))
  if (normalized.startsWith('~')) return satisfiesTilde(version, normalized.slice(1))
  return normalized
    .split(/\s+/)
    .every((comparator) => satisfiesComparator(version, comparator))
}

/**
 * Deterministic range matcher covering exact versions, `*`, caret, tilde,
 * comparator intersections, and `||` alternatives. The updater intentionally
 * ships its own matcher so requirement strings resolve identically on every
 * host without a runtime dependency.
 */
export function satisfiesKernelVersionRange(
  version: string,
  range?: string,
): boolean {
  const parsed = parseKernelVersion(version)
  if (isUndefined(range) || isBlank(range.trim())) return true
  return range
    .split('||')
    .some((clause) => satisfiesClause(parsed, clause))
}
