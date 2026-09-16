// 更新器侧的语义化版本判定：口径来自 `utils/semver.ts`，这里只负责把中立的解析失败翻译成
// `KernelUpdaterError`（带上更新器关心的 details）。
import { KernelUpdaterError } from '../errors-updater'
import {
  compareSemanticVersions,
  isSemanticVersion,
  parseSemanticVersion,
  satisfiesSemanticVersionRange,
  type SemanticVersion,
  SemanticVersionError,
  SemanticVersionPattern,
} from '../semver'

export type KernelSemanticVersion = SemanticVersion

export const KernelVersionPattern = SemanticVersionPattern

function toUpdaterError(error: unknown, source: string): unknown {
  if (!(error instanceof SemanticVersionError)) return error
  return error.kind === 'version'
    ? new KernelUpdaterError('INVALID_VERSION', `Invalid Kernel version "${source}"`, {
        version: source,
      })
    : new KernelUpdaterError(
        'INVALID_VERSION_RANGE',
        `Invalid Kernel version range "${error.source}"`,
        { versionRange: error.source },
      )
}

export function parseKernelVersion(source: string): KernelSemanticVersion {
  try {
    return parseSemanticVersion(source)
  } catch (error) {
    throw toUpdaterError(error, source)
  }
}

export function assertKernelVersion(version: string): void {
  parseKernelVersion(version)
}

export function isKernelVersion(version: string): boolean {
  return isSemanticVersion(version)
}

/** Prerelease builds sort below their release, matching SemVer §11. */
export function compareKernelVersions(left: string, right: string): number {
  try {
    return compareSemanticVersions(left, right)
  } catch (error) {
    throw toUpdaterError(error, left)
  }
}

/**
 * Deterministic range matcher covering exact versions, `*`, caret, tilde,
 * comparator intersections, and `||` alternatives. The Kernel intentionally
 * ships its own matcher so requirement strings resolve identically on every
 * host without a runtime dependency.
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
