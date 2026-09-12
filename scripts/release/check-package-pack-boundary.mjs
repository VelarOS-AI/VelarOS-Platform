#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const currentFile = fileURLToPath(import.meta.url)
const allowedFiles = new Set([
  path.join(repositoryRoot, 'scripts', 'release', 'safe-package-pack.mjs'),
  path.join(repositoryRoot, 'scripts', 'release', 'safe-package-pack.test.mjs'),
  path.join(repositoryRoot, 'scripts', 'memory', 'checks', 'packageConsumerRunner.test.mjs'),
  path.join(repositoryRoot, 'scripts', 'model', 'checks', 'packageConsumerRunner.test.mjs'),
])
const ignoredDirectories = new Set([
  '.git',
  '.velaros-workspace',
  'coverage',
  'dist',
  'node_modules',
  'out',
])
const executableExtensions = new Set([
  '.bash',
  '.cjs',
  '.js',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
  '.zsh',
])
const unsafePatterns = [
  /\bbun\s+pm\s+pack\b/u,
  /\[\s*['"]pm['"]\s*,\s*['"]pack['"]/u,
]

function shouldScanFile(filePath) {
  const basename = path.basename(filePath)
  if (basename === 'package.json') return true
  return executableExtensions.has(path.extname(filePath))
}

async function collectExecutableSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  // 嵌套的 git 检出（其他会话放在仓库目录里的 worktree、子仓库）不是本仓源码，由它自己的门禁负责。
  if (directory !== repositoryRoot && entries.some((entry) => entry.name === '.git')) return []

  const files = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue
      files.push(...await collectExecutableSources(entryPath))
    } else if (entry.isFile() && shouldScanFile(entryPath)) {
      files.push(entryPath)
    }
  }
  return files
}

const violations = []
for (const filePath of await collectExecutableSources(repositoryRoot)) {
  if (allowedFiles.has(filePath) || filePath === currentFile) continue
  const source = await readFile(filePath, 'utf8')
  if (unsafePatterns.some((pattern) => pattern.test(source))) {
    violations.push(path.relative(repositoryRoot, filePath))
  }
}

if (violations.length > 0) {
  throw new Error(
    `Raw package packing bypasses the timeout/path guard:\n${violations.map((file) => `- ${file}`).join('\n')}`,
  )
}

console.info('✓ all repository package packing uses the guarded runner')
