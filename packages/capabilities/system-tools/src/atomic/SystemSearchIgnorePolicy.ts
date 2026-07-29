import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

interface GitIgnoreRule {
  baseRelativePath: string
  negative: boolean
  directoryOnly: boolean
  anchored: boolean
  segments: string[]
}

export interface SystemSearchIgnorePolicyOptions {
  unrestricted?: boolean
}

export interface SystemSearchIgnorePolicy {
  shouldSkip(candidatePath: string, isDirectory: boolean): Promise<boolean>
}

const NoopSystemSearchIgnorePolicy: SystemSearchIgnorePolicy = {
  shouldSkip: async () => false,
}

export async function createSystemSearchIgnorePolicy(
  rootPath: string,
  options: SystemSearchIgnorePolicyOptions = {}
): Promise<SystemSearchIgnorePolicy> {
  if (options.unrestricted) return NoopSystemSearchIgnorePolicy

  const resolvedRootPath = resolve(rootPath)
  const repoRootPath = await findSystemSearchRepoRoot(resolvedRootPath)
  if (!repoRootPath) return NoopSystemSearchIgnorePolicy

  const policy = new GitIgnoreSystemSearchPolicy(resolvedRootPath, repoRootPath)
  if (await policy.isIgnoredRoot()) return NoopSystemSearchIgnorePolicy
  return policy
}

class GitIgnoreSystemSearchPolicy implements SystemSearchIgnorePolicy {
  private readonly rulesByDirectoryPath = new Map<string, Promise<GitIgnoreRule[]>>()

  constructor(
    private readonly rootPath: string,
    private readonly repoRootPath: string
  ) {}

  public async isIgnoredRoot(): Promise<boolean> {
    if (this.rootPath === this.repoRootPath) return false

    const rootStats = await stat(this.rootPath).catch(() => null)
    return this.isIgnored(this.rootPath, !!rootStats?.isDirectory())
  }

  public async shouldSkip(candidatePath: string, isDirectory: boolean): Promise<boolean> {
    const resolvedCandidatePath = resolve(candidatePath)
    if (resolvedCandidatePath === this.rootPath) return false
    return this.isIgnored(resolvedCandidatePath, isDirectory)
  }

  private async isIgnored(candidatePath: string, isDirectory: boolean): Promise<boolean> {
    if (!isInsidePath(candidatePath, this.repoRootPath)) return false

    const ruleDirectoryPath = isDirectory ? candidatePath : dirname(candidatePath)
    const rules = await this.loadRulesForDirectory(ruleDirectoryPath)
    if (rules.length === 0) return false

    const candidateRelativePath = toPortableRelativePath(this.repoRootPath, candidatePath)
    let ignored = false
    for (const rule of rules) {
      if (matchesGitIgnoreRule(rule, candidateRelativePath, isDirectory)) {
        ignored = !rule.negative
      }
    }
    return ignored
  }

  private loadRulesForDirectory(directoryPath: string): Promise<GitIgnoreRule[]> {
    const resolvedDirectoryPath = resolve(directoryPath)
    const existing = this.rulesByDirectoryPath.get(resolvedDirectoryPath)
    if (existing) return existing

    const promise = this.loadRulesForDirectoryUncached(resolvedDirectoryPath)
    this.rulesByDirectoryPath.set(resolvedDirectoryPath, promise)
    return promise
  }

  private async loadRulesForDirectoryUncached(directoryPath: string): Promise<GitIgnoreRule[]> {
    const directories = directoriesBetween(this.repoRootPath, directoryPath)
    const rules: GitIgnoreRule[] = []

    for (const directory of directories) {
      const baseRelativePath = toPortableRelativePath(this.repoRootPath, directory)
      const lines = await readIgnoreLines(`${directory}${sep}.gitignore`)
      for (const line of lines) {
        const rule = parseGitIgnoreRule(line, baseRelativePath)
        if (rule) rules.push(rule)
      }
    }

    return rules
  }
}

async function findSystemSearchRepoRoot(startPath: string): Promise<string | null> {
  let currentPath = resolve(startPath)
  const startStats = await stat(currentPath).catch(() => null)
  if (startStats?.isFile()) currentPath = dirname(currentPath)

  while (true) {
    const gitMarker = await stat(`${currentPath}${sep}.git`).catch(() => null)
    if (gitMarker) return currentPath

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) return null
    currentPath = parentPath
  }
}

async function readIgnoreLines(path: string): Promise<string[]> {
  const content = await readFile(path, 'utf-8').catch(() => '')
  if (content.length === 0) return []
  return content.split(/\r?\n/u)
}

function parseGitIgnoreRule(
  rawLine: string,
  baseRelativePath: string
): GitIgnoreRule | null {
  let line = rawLine.trimEnd()
  if (line.length === 0 || line.startsWith('#')) return null

  let negative = false
  if (line.startsWith('!')) {
    negative = true
    line = line.slice(1)
  } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
    line = line.slice(1)
  }

  const directoryOnly = line.endsWith('/')
  line = line.replace(/^\/+/u, '').replace(/\/+$/u, '')
  if (line.length === 0) return null

  const anchored = rawLine.startsWith('/') || line.includes('/')
  return {
    baseRelativePath,
    negative,
    directoryOnly,
    anchored,
    segments: line.split('/').filter((segment) => segment.length > 0),
  }
}

function matchesGitIgnoreRule(
  rule: GitIgnoreRule,
  candidateRelativePath: string,
  isDirectory: boolean
): boolean {
  const candidateSegments = candidateRelativePath
    .split('/')
    .filter((segment) => segment.length > 0)
  if (candidateSegments.length === 0) return false

  const baseSegments = rule.baseRelativePath.length === 0 || rule.baseRelativePath === '.'
    ? []
    : rule.baseRelativePath.split('/').filter((segment) => segment.length > 0)
  if (!startsWithSegments(candidateSegments, baseSegments)) return false

  const scopedSegments = candidateSegments.slice(baseSegments.length)
  if (scopedSegments.length === 0) return false

  if (rule.anchored) {
    if (!startsWithSegments(scopedSegments, rule.segments)) return false
    return !rule.directoryOnly || isDirectory || scopedSegments.length > rule.segments.length
  }

  for (let index = 0; index < scopedSegments.length; index += 1) {
    const segment = scopedSegments[index] ?? ''
    if (!matchesGitIgnoreSegment(rule.segments[0] ?? '', segment)) continue
    return !rule.directoryOnly || isDirectory || index < scopedSegments.length - 1
  }

  return false
}

function matchesGitIgnoreSegment(pattern: string, value: string): boolean {
  if (pattern === value) return true
  const expression = new RegExp(`^${gitIgnoreSegmentPatternToRegex(pattern)}$`, 'u')
  return expression.test(value)
}

function gitIgnoreSegmentPatternToRegex(pattern: string): string {
  let expression = ''
  for (const char of pattern) {
    switch (char) {
      case '*':
        expression += '[^/]*'
        break
      case '?':
        expression += '[^/]'
        break
      default:
        expression += escapeRegexChar(char)
        break
    }
  }
  return expression
}

function escapeRegexChar(char: string): string {
  return /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char
}

function directoriesBetween(rootPath: string, directoryPath: string): string[] {
  const directories: string[] = []
  let currentPath = resolve(directoryPath)

  while (isInsidePath(currentPath, rootPath)) {
    directories.push(currentPath)
    if (currentPath === rootPath) break
    currentPath = dirname(currentPath)
  }

  directories.reverse()
  return directories
}

function startsWithSegments(candidate: string[], prefix: string[]): boolean {
  if (prefix.length > candidate.length) return false
  return prefix.every((segment, index) => candidate[index] === segment)
}

function isInsidePath(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = resolve(candidatePath)
  const resolvedRoot = resolve(rootPath)
  if (resolvedCandidate === resolvedRoot) return true
  if (!isAbsolute(resolvedCandidate) || !isAbsolute(resolvedRoot)) return false
  return resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
}

function toPortableRelativePath(rootPath: string, candidatePath: string): string {
  return relative(rootPath, candidatePath).replaceAll('\\', '/')
}
