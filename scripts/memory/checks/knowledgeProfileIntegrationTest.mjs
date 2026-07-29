#!/usr/bin/env node
// 用途：用 Electron 的原生 SQLite ABI 运行 Knowledge 向量 profile 集成测试。

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const buildDir = mkdtempSync(
  join(repoRoot, '.knowledge-profile-test-')
)
const outputFile = join(buildDir, 'knowledge-profile-integration.test.mjs')
const entryFile = join(
  repoRoot,
  'tests',
  'maintained',
  'packages',
  'memory',
  'KnowledgeVectorsProfileIntegration.test.ts'
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
      '--outdir',
      buildDir,
      '--entry-naming',
      'knowledge-profile-integration.test.mjs',
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
    const test = spawnSync(electronBinary, ['--test', outputFile], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: 'inherit',
    })
    if (test.error) throw test.error
    process.exitCode = test.status ?? 1
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}
