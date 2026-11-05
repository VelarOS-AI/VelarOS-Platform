#!/usr/bin/env node
// 在五分钟内聚合默认质量门并报告全部失败。
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const root = new URL('../../', import.meta.url)
const deadlineMs = 290_000
const started = performance.now()
const failures = []
const skipped = []

function run(name, command, args) {
  const remaining = Math.floor(deadlineMs - (performance.now() - started))
  if (remaining <= 0) {
    skipped.push(`${name}（总预算已耗尽）`)
    return false
  }
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: remaining,
    windowsHide: true,
  })
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  if (result.status !== 0 || result.error) {
    failures.push({
      name,
      status: result.status,
      signal: result.signal,
      timedOut: result.error?.code === 'ETIMEDOUT',
      output,
    })
    console.error(`\n✖ ${name}\n${output || result.error?.message || 'unknown failure'}`)
    return false
  }
  console.info(`✓ ${name}`)
  return true
}

const bun = process.platform === 'win32' ? 'bun.exe' : 'bun'
const node = process.execPath

// 这些检查互补且便宜；继续执行可在一次本地运行里汇总格式、静态和声明错误。
run('format', bun, ['run', 'check:format'])
run('lint', bun, ['run', 'lint'])
run('lockfile', bun, ['run', 'check:lockfile-consistency'])
run('project architecture', bun, ['run', 'check:project-arch'])
run('generated platform', bun, ['run', 'check:platform-generation'])
run('package catalog', bun, ['run', 'check:package-catalog'])
run('release contracts', bun, ['run', 'check:release-source'])
const built = run('build', bun, ['run', 'build'])

if (built) {
  // 包入口解析 dist 声明；干净 checkout 必须先构建，再检查跨包类型。
  run('typecheck', bun, ['run', 'typecheck'])
  const pattern = [
    'historical user images remain',
    'user-only image input remains',
    'INV-52 current constraints',
    'task projection: lossless',
    'task projection: SQLite',
    '编辑提示并列提供',
    'Node 验收说明按实际改动',
    'Platform 执行策略',
    'base instructions stay small',
    'Node hints expose only',
    'runtime delivers native output',
  ].join('|')
  run('core runtime behavior', node, [
    '--test',
    '--test-name-pattern',
    pattern,
    'packages/velaros/act/runtime/test/context-index.test.mjs',
    'packages/velaros/act/runtime/test/context-memory.test.mjs',
    'packages/velaros/act/runtime/test/foundation-context.test.mjs',
    'packages/velaros/act/runtime/test/host-instructions.test.mjs',
    'packages/velaros/act/runtime/test/node-runtime.test.mjs',
    'packages/velaros/act/runtime/test/text-runtime.test.mjs',
  ])
} else skipped.push('typecheck（构建失败）', 'core runtime behavior（构建失败）')

const durationMs = Math.round(performance.now() - started)
if (skipped.length) console.error(`跳过：${skipped.join('；')}`)
if (failures.length || skipped.length) {
  console.error(
    `快速门禁失败：${failures.length} 项失败，${skipped.length} 项跳过，${durationMs}ms`
  )
  process.exitCode = 1
} else console.info(`✓ 快速门禁全部通过（${durationMs}ms，预算 ${deadlineMs}ms）`)
