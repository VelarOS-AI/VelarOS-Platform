export const ProjectExcludedDirectoryNames: string[] = [
  '.codegraph',
  '.data',
  '.git',
  'build',
  'dist',
  'node_modules',
  'out',
]

/**
 * Explicit model access must only reject directories that are private or unsafe to expose.
 *
 * Generated-directory names such as `build`, `dist`, and `out` remain excluded from broad
 * discovery through {@link ProjectExcludedDirectoryNames}, but they are also legitimate source
 * directory names (for example `scripts/build`). Treating every matching path segment as an
 * authorization boundary made explicit reads and code queries fail with PERMISSION_DENIED.
 */
export const ProjectModelRestrictedDirectoryNames: string[] = [
  '.codegraph',
  '.data',
  '.git',
  'node_modules',
]

export const ProjectDiscoverySkippedDirectoryNames: string[] = [
  '.codegraph',
  '.git',
  '.hg',
  '.jj',
  '.svn',
  'node_modules',
  'vendor',
  '.venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.data',
  'dist',
  'build',
  'out',
  'coverage',
  '.idea',
  '.vscode',
  'Library',
]

export const ProjectHiddenDirectoryAllowlist: string[] = [
  '.xcodeproj',
  '.xcworkspace',
]

const ProjectExcludedDirectoryNameSet =
  new Set(ProjectExcludedDirectoryNames)
const ProjectModelRestrictedDirectoryNameSet =
  new Set(ProjectModelRestrictedDirectoryNames)
const ProjectDiscoverySkippedDirectoryNameSet =
  new Set(ProjectDiscoverySkippedDirectoryNames)
const ProjectHiddenDirectoryAllowlistSet =
  new Set(ProjectHiddenDirectoryAllowlist)

export function shouldSkipProjectDirectory(name: string): boolean {
  return ProjectExcludedDirectoryNameSet.has(name)
}

export function shouldRestrictProjectModelPathSegment(name: string): boolean {
  return ProjectModelRestrictedDirectoryNameSet.has(name)
}

export function shouldSkipProjectDiscoveryDirectory(
  name: string,
  excludeNames: ReadonlySet<string>,
): boolean {
  if (excludeNames.has(name)) return true
  if (
    name.startsWith('.')
    && !ProjectHiddenDirectoryAllowlistSet.has(name)
  ) return true
  return ProjectDiscoverySkippedDirectoryNameSet.has(name)
}
