#!/usr/bin/env node
// 用途：用 Electron 原生 SQLite 运行记忆树 v2 authority/open/migrate 与静态加密回归探针。

import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '..', '..')
// bundle 必须落在 repo 内，ESM 才会沿父目录解析本仓原生 better-sqlite3；
// finally 恒清理，不把探针产物留进 worktree。
const buildDir = mkdtempSync(join(repoRoot, '.memory-authority-probe-'))
const outputFile = join(buildDir, 'authority-v2-probe.mjs')
const entryFile = join(
  repoRoot,
  'packages',
  'memory',
  'src',
  'memory-tree',
  'v2',
  'authority-v2-probe.ts'
)
const electronBinary = join(repoRoot, 'node_modules', '.bin', 'electron')

try {
  const build = spawnSync(
    'bun',
    [
      'build',
      entryFile,
      '--target=node',
      '--format=esm',
      '--external',
      'better-sqlite3',
      '--outfile',
      outputFile,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  )
  if (build.status !== 0) {
    process.stderr.write(build.stdout ?? '')
    process.stderr.write(build.stderr ?? '')
    process.exitCode = build.status ?? 1
  } else {
    const probe = spawnSync(electronBinary, [outputFile], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: 'inherit',
    })
    if (probe.error) throw probe.error
    process.exitCode = probe.status ?? 1
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}
