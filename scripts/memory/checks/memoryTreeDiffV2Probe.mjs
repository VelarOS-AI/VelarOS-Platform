#!/usr/bin/env node
// 用途：运行记忆树 v2 TreeDiff 冻结规范的逐字节回归探针（只算哈希与回放，不开库，但照走同一条打包路径）。

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const buildDir = mkdtempSync(join(repoRoot, '.memory-treediff-probe-'))
const outputFile = join(buildDir, 'treediff-v2-probe.mjs')
const entryFile = join(
  repoRoot,
  'packages',
  'velar',
  'memory',
  'test',
  'probes',
  'tree-v2',
  'treediff.probe.ts'
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
