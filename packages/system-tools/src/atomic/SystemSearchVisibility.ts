export const SystemSearchSkippedDirectoryNames: string[] = [
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

export const MacosTccProtectedSearchDirectoryNames: string[] = [
  'Music',
  'Pictures',
  'Movies',
  'Library',
]

export interface SystemSearchProtectedDirectoryInput {
  platform: string
  homeDir: string
  rootPath: string
  candidatePath: string
}

const SystemSearchSkippedDirectoryNameSet =
  new Set(SystemSearchSkippedDirectoryNames)

export function shouldSkipSystemSearchEntry(
  name: string,
  isDirectory: boolean,
  includeHidden: boolean,
  unrestricted = false,
): boolean {
  if (unrestricted) return false
  if (!includeHidden && name.startsWith('.')) return true
  return isDirectory && SystemSearchSkippedDirectoryNameSet.has(name)
}

export function shouldSkipSystemSearchProtectedDirectory(
  input: SystemSearchProtectedDirectoryInput,
): boolean {
  if (input.platform !== 'darwin') return false

  const rootPath = normalizePolicyPath(input.rootPath)
  const candidatePath = normalizePolicyPath(input.candidatePath)
  if (candidatePath === rootPath) return false

  const homeDir = normalizePolicyPath(input.homeDir)
  return MacosTccProtectedSearchDirectoryNames.some(
    (name) => candidatePath === normalizePolicyPath(`${homeDir}/${name}`),
  )
}

function normalizePolicyPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+/gu, '/')
  return normalized.length <= 1 ? normalized : normalized.replace(/\/+$/u, '')
}
