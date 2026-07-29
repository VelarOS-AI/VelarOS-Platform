#!/usr/bin/env bun
// 用途:Kernel wire 协议的形状保形检查。
//
// 协议 schema 的唯一实现住在 packages/kernel-client/src/protocol(Client 与 Kernel 内部共享同一份 zod)。
// 本脚本消费该包构建出的快照产物,与审核基线逐 schema 比对,拦住无意的 wire 形状漂移。
//
// 有意的协议变化:SCHEMA_BASELINE_UPDATE=1 bun scripts/check-schemas.mjs 重生成基线,并在提交信息里说明差异。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(HERE, '..')
const BaselinePath = join(RepoRoot, 'baselines', 'kernel-wire-schema-snapshot.json')
const SnapshotPath = join(
  RepoRoot,
  'packages',
  'kernel-client',
  'dist',
  'schema-snapshot.json',
)

function stableStringify(value) {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
    return val
  })
}

if (!existsSync(SnapshotPath)) {
  console.error(
    `❌ @velaros-ai/kernel-client: 找不到 wire schema 快照(${SnapshotPath})——请先构建该包:bun run --cwd packages/kernel-client build`,
  )
  process.exit(1)
}

const currentSnapshot = JSON.parse(readFileSync(SnapshotPath, 'utf8'))

if (process.env.SCHEMA_BASELINE_UPDATE === '1' || !existsSync(BaselinePath)) {
  const existed = existsSync(BaselinePath)
  writeFileSync(BaselinePath, `${JSON.stringify(currentSnapshot, null, 2)}\n`)
  console.info(`✓ 基线已${existed ? '更新' : '生成'}:${BaselinePath}`)
  process.exit(0)
}

const baselineSnapshot = JSON.parse(readFileSync(BaselinePath, 'utf8'))
const drift = []
if (currentSnapshot.protocolVersion !== baselineSnapshot.protocolVersion) {
  drift.push(
    `protocolVersion ${baselineSnapshot.protocolVersion}→${currentSnapshot.protocolVersion}`,
  )
}

const currentSchemas = currentSnapshot.schemas ?? {}
const baselineSchemas = baselineSnapshot.schemas ?? {}
for (const name of new Set([
  ...Object.keys(currentSchemas),
  ...Object.keys(baselineSchemas),
])) {
  if (!(name in baselineSchemas)) drift.push(`+${name}`)
  else if (!(name in currentSchemas)) drift.push(`-${name}`)
  else if (stableStringify(currentSchemas[name]) !== stableStringify(baselineSchemas[name])) drift.push(`~${name}`)
}

if (drift.length > 0) {
  console.error(`❌ Kernel wire schema 快照与基线不一致:${drift.join(', ')}`)
  console.error(
    '   协议形状变更请 SCHEMA_BASELINE_UPDATE=1 bun scripts/check-schemas.mjs 重生成并在提交里说明。',
  )
  process.exit(1)
}

console.info(
  `✓ Kernel wire schema 快照 ${Object.keys(currentSchemas).length} 个 schema 与基线一致(protocol v${currentSnapshot.protocolVersion})`,
)
