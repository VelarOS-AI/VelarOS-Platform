import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import {
  join,
  relative,
  sep,
} from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { readErrnoCode, resolveSystemPathInput } from './Filesystem.js'
import { shouldSkipSystemSearchProtectedDirectory } from './SystemSearchVisibility.js'

export interface AtomicListDirInput {
  path: string
  recursive?: boolean
  maxDepth?: number
  limit: number
}

export interface AtomicListDirEntry {
  path: string
  type: 'file' | 'directory' | 'symlink'
}

export interface AtomicListDirResult {
  rootPath: string
  count: number
  truncated: boolean
  entries: AtomicListDirEntry[]
}

export interface AtomicListDirOptions {
  homeDir?: string
  platform?: string
}

async function collectEntries(
  rootPath: string,
  currentPath: string,
  depth: number,
  maxDepth: number,
  recursive: boolean,
  limit: number,
  entries: AtomicListDirEntry[],
  options: Required<AtomicListDirOptions>
): Promise<boolean> {
  if (entries.length >= limit) return true

  let names: string[]
  try {
    names = await readdir(currentPath)
  } catch (err) {
    switch (readErrnoCode(err)) {
      case 'ENOENT':
        throw new AppError('NOT_FOUND', `Directory not found: ${currentPath}`)
      case 'EACCES':
        throw new AppError('PERMISSION', `Permission denied listing directory: ${currentPath}`)
      default:
        throw err
    }
  }

  names.sort((a, b) => a.localeCompare(b))

  for (const name of names) {
    if (entries.length >= limit) return true

    const absolutePath = join(currentPath, name)
    let entryType: AtomicListDirEntry['type']
    try {
      const stats = await lstat(absolutePath)
      entryType = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file'
    } catch {
      // arch-guard:silent-catch-ok 目录枚举是 best-effort；瞬时消失或不可读子项跳过。
      continue
    }

    if (
      entryType === 'directory' &&
      shouldSkipSystemSearchProtectedDirectory({
        platform: options.platform,
        homeDir: options.homeDir,
        rootPath,
        candidatePath: absolutePath,
      })
    ) {
      continue
    }

    entries.push({
      path: relative(rootPath, absolutePath).split(sep).join('/') || '.',
      type: entryType,
    })

    if (recursive && entryType === 'directory' && depth < maxDepth) {
      const truncated = await collectEntries(
        rootPath,
        absolutePath,
        depth + 1,
        maxDepth,
        recursive,
        limit,
        entries,
        options
      )
      if (truncated) return true
    }
  }

  return entries.length >= limit
}

export async function executeAtomicListDir(
  input: AtomicListDirInput,
  options: AtomicListDirOptions = {}
): Promise<AtomicListDirResult> {
  const requestedRootPath = resolveSystemPathInput(input.path)
  const stats = await stat(requestedRootPath).catch(() => null)
  if (!stats) {
    throw new AppError('NOT_FOUND', `Directory not found: ${requestedRootPath}`)
  }
  if (!stats.isDirectory()) {
    throw new AppError('VALIDATION', `Path is not a directory: ${requestedRootPath}`)
  }

  const rootPath = await realpath(requestedRootPath).catch(() => requestedRootPath)
  const entries: AtomicListDirEntry[] = []
  const maxDepth = input.maxDepth ?? (input.recursive ? 4 : 0)
  const requestedHomeDir = options.homeDir ?? homedir()
  const resolvedOptions: Required<AtomicListDirOptions> = {
    homeDir: await realpath(requestedHomeDir).catch(() => requestedHomeDir),
    platform: options.platform ?? platform(),
  }
  const truncated = await collectEntries(
    rootPath,
    rootPath,
    0,
    maxDepth,
    !!input.recursive,
    input.limit,
    entries,
    resolvedOptions
  )

  return {
    rootPath,
    count: entries.length,
    truncated,
    entries,
  }
}
