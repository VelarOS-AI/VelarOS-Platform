export const ProjectExcludedDirectoryNames: string[] = [
  '.codegraph',
  '.data',
  '.git',
  'build',
  'dist',
  'node_modules',
  'out',
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
const ProjectDiscoverySkippedDirectoryNameSet =
  new Set(ProjectDiscoverySkippedDirectoryNames)
const ProjectHiddenDirectoryAllowlistSet =
  new Set(ProjectHiddenDirectoryAllowlist)

export function shouldSkipProjectDirectory(name: string): boolean {
  return ProjectExcludedDirectoryNameSet.has(name)
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
