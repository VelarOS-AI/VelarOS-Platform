export const WorkspaceToolExcludedDirectoryNames: string[] = [
  '.codegraph',
  '.data',
  '.git',
  'build',
  'dist',
  'node_modules',
  'out',
]

export const WorkspaceDiscoverySkippedDirectoryNames: string[] = [
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

export const WorkspaceHiddenDirectoryAllowlist: string[] = [
  '.xcodeproj',
  '.xcworkspace',
]

const WorkspaceToolExcludedDirectoryNameSet =
  new Set(WorkspaceToolExcludedDirectoryNames)
const WorkspaceDiscoverySkippedDirectoryNameSet =
  new Set(WorkspaceDiscoverySkippedDirectoryNames)
const WorkspaceHiddenDirectoryAllowlistSet =
  new Set(WorkspaceHiddenDirectoryAllowlist)

export function shouldSkipWorkspaceToolDirectory(name: string): boolean {
  return WorkspaceToolExcludedDirectoryNameSet.has(name)
}

export function shouldSkipProjectDiscoveryDirectory(
  name: string,
  excludeNames: ReadonlySet<string>,
): boolean {
  if (excludeNames.has(name)) return true
  if (
    name.startsWith('.')
    && !WorkspaceHiddenDirectoryAllowlistSet.has(name)
  ) return true
  return WorkspaceDiscoverySkippedDirectoryNameSet.has(name)
}
