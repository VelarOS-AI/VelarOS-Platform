import { KernelHostError } from './errors'

interface SemanticVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

function parseNumericPart(value: string, source: string): number {
  if (!/^\d+$/.test(value)) {
    throw new KernelHostError(
      'INVALID_VERSION',
      `Invalid semantic version "${source}"`,
    )
  }

  return Number(value)
}

function parseSemanticVersion(
  source: string,
  errorCode: 'INVALID_VERSION' | 'INVALID_VERSION_RANGE' = 'INVALID_VERSION',
): SemanticVersion {
  const normalized = source.trim().replace(/^v/, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(normalized)
  if (!match) {
    throw new KernelHostError(
      errorCode,
      `Invalid semantic version "${source}"`,
    )
  }

  return {
    major: parseNumericPart(match[1]!, source),
    minor: parseNumericPart(match[2]!, source),
    patch: parseNumericPart(match[3]!, source),
  }
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

function satisfiesComparator(
  version: SemanticVersion,
  comparator: string,
): boolean {
  const match = /^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
    comparator,
  )
  if (!match) {
    throw new KernelHostError(
      'INVALID_VERSION_RANGE',
      `Invalid semantic version range comparator "${comparator}"`,
    )
  }

  const operator = match[1] ?? '='
  const target = parseSemanticVersion(match[2]!, 'INVALID_VERSION_RANGE')
  const comparison = compareVersions(version, target)
  switch (operator) {
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

function satisfiesCaret(version: SemanticVersion, source: string): boolean {
  const lower = parseSemanticVersion(source, 'INVALID_VERSION_RANGE')
  const upper: SemanticVersion = lower.major > 0
    ? { major: lower.major + 1, minor: 0, patch: 0 }
    : lower.minor > 0
      ? { major: 0, minor: lower.minor + 1, patch: 0 }
      : { major: 0, minor: 0, patch: lower.patch + 1 }

  return compareVersions(version, lower) >= 0
    && compareVersions(version, upper) < 0
}

function satisfiesTilde(version: SemanticVersion, source: string): boolean {
  const lower = parseSemanticVersion(source, 'INVALID_VERSION_RANGE')
  const upper: SemanticVersion = {
    major: lower.major,
    minor: lower.minor + 1,
    patch: 0,
  }

  return compareVersions(version, lower) >= 0
    && compareVersions(version, upper) < 0
}

function satisfiesClause(version: SemanticVersion, clause: string): boolean {
  const normalized = clause.trim()
  if (normalized.length === 0 || normalized === '*') return true
  if (normalized.startsWith('^')) return satisfiesCaret(version, normalized.slice(1))
  if (normalized.startsWith('~')) return satisfiesTilde(version, normalized.slice(1))

  const comparators = normalized.split(/\s+/)
  return comparators.every((comparator) =>
    satisfiesComparator(version, comparator))
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
  const version = parseSemanticVersion(versionSource)
  if (rangeSource === undefined || rangeSource.trim().length === 0) return true

  const alternatives = rangeSource.split('||')
  return alternatives.some((clause) => satisfiesClause(version, clause))
}

export function assertSemanticVersion(version: string): void {
  parseSemanticVersion(version)
}
