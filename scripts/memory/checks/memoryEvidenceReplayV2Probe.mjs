#!/usr/bin/env node
// 用途：用 Electron 原生 SQLite 运行 S7 旧 Evidence 只读重灌、逐条 parity 与切权闸门探针。

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const buildDir = mkdtempSync(join(repoRoot, '.memory-evidence-replay-probe-'))
const outputFile = join(buildDir, 'evidence-replay-v2-probe.mjs')
const entryFile = join(
  repoRoot,
  'packages',
  'memory',
  'src',
  'memory-tree',
  'v2',
  'evidence-replay-v2-probe.ts'
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
