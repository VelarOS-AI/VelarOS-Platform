#!/usr/bin/env node
// 用途:react-hooks/exhaustive-deps 的基线棘轮——逐文件比对存量违规清单,只准缩小不准增长。
//
// 为什么不是直接 error:这条规则对 ref、稳定函数、以及「刻意细粒度订阅某几个字段」的写法假阳性
// 有名,一刀 error 会逼人把正确代码改坏。所以它在 eslint/ui.config.mjs 里停在 warn,`bun run lint`
// 用 --quiet 只收 error,硬门由本探针承担(与 Desktop scripts/checks/reactHookDeps.mjs 同形态)。
//
// 为什么必须开:Desktop 侧它抓到过两个真 bug(1f50cec7b ChatCommandConsoleSurface 漏 sessionId、
// 81f959ce2 flushAllPendingText 同类闭包),都是「跨会话串台 / 数据丢失」级。ui 是本仓唯一有 React
// 的包(175 个 .tsx / 86 个用 hook 的文件),这条规则此前一条都不跑——不是纪律松,是门没铺过来。
//
// 覆盖点:
//  ① 违规清单:以最小 flat config(只开这一条规则、免类型信息)扫描 packages/ui/src 与
//     component-library/src(仓内仅有的两处 React 源);
//  ② 棘轮:逐文件计数与 baselines/ui/react-hook-deps.json 比对——超出即红,减少也红(要求刷基线),
//     基线只会单调变小;`--update` 刷新基线;
//  ③ --quiet 的护栏:静态核对根 eslint.config.mjs(它组合了全部七个域配置)里的 warn 级规则只有
//     登记过的这一条,否则新加的 warn 规则会被 lint 的 --quiet 静默吞掉。
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

import tsParser from '@typescript-eslint/parser'
import { ESLint } from 'eslint'
import reactHooks from 'eslint-plugin-react-hooks'

import { RepoRoot } from './archGateLib.mjs'

const BaselinePath = resolve(RepoRoot, 'baselines/ui/react-hook-deps.json')
const ScanRoots = [
  resolve(RepoRoot, 'packages/ui/src'),
  resolve(RepoRoot, 'component-library/src'),
]
const RuleId = 'react-hooks/exhaustive-deps'
// 允许以 warn 级出现在共享 eslint 配置里的规则。lint 走 --quiet,凡是没登记的 warn 规则都会被吞。
const AllowedWarnRules = new Set([RuleId])

const shouldUpdate = process.argv.includes('--update')

function toPosix(filePath) {
  return relative(RepoRoot, filePath).split(sep).join('/')
}

/** 只开一条规则、不加载 tsconfig(这条规则不需要类型信息),比复用主配置快一个量级。 */
function buildLintConfig() {
  return [
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: {
        ecmaVersion: 'latest',
        parser: tsParser,
        parserOptions: { ecmaFeatures: { jsx: true }, project: false },
        sourceType: 'module',
      },
      plugins: { 'react-hooks': reactHooks },
      rules: { [RuleId]: 'warn' },
    },
  ]
}

async function collectViolations() {
  const eslint = new ESLint({
    cwd: RepoRoot,
    overrideConfigFile: true,
    overrideConfig: buildLintConfig(),
  })
  const results = await eslint.lintFiles(ScanRoots)
  const counts = {}

  for (const result of results) {
    const hits = result.messages.filter((message) => message.ruleId === RuleId)
    if (hits.length === 0) continue
    counts[toPosix(result.filePath)] = hits.length
  }

  return counts
}

/** 静态核对共享配置:根 flat config 数组里所有 warn 级规则都必须在登记表内。 */
async function collectUnregisteredWarnRules() {
  const configModule = await import(resolve(RepoRoot, 'eslint.config.mjs'))
  const flatConfig = configModule.default
  const offenders = new Set()

  for (const block of Array.isArray(flatConfig) ? flatConfig : []) {
    for (const [ruleId, severity] of Object.entries(block?.rules ?? {})) {
      const level = Array.isArray(severity) ? severity[0] : severity
      if (level !== 'warn' && level !== 1) continue
      if (!AllowedWarnRules.has(ruleId)) offenders.add(ruleId)
    }
  }

  return [...offenders].sort()
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BaselinePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`基线文件解析失败:${toPosix(BaselinePath)}`, { cause: error })
  }
}

function saveBaseline(counts) {
  const ordered = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BaselinePath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}

const counts = await collectViolations()
const total = Object.values(counts).reduce((sum, count) => sum + count, 0)

if (shouldUpdate) {
  saveBaseline(counts)
  console.log(
    `已刷新基线:${toPosix(BaselinePath)}(${Object.keys(counts).length} 个文件 / ${total} 条)。`,
  )
  process.exit(0)
}

const baseline = loadBaseline()
const failures = []
const stale = []

for (const [file, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
  const allowed = baseline[file] ?? 0
  if (count > allowed) {
    failures.push(
      `${file}:${RuleId} 违规 ${count} 条,基线只允许 ${allowed} 条。` +
        `请补全依赖表;确属假阳性(ref / 稳定函数 / 刻意细粒度订阅)就写` +
        ` \`// eslint-disable-next-line ${RuleId} -- <原因>\`。`,
    )
  }
}

for (const [file, allowed] of Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))) {
  const count = counts[file] ?? 0
  if (count < allowed) stale.push(`${file}:基线 ${allowed} 条,实际只剩 ${count} 条`)
}

const unregisteredWarnRules = await collectUnregisteredWarnRules()

if (failures.length > 0) {
  console.error('[ui-hook-deps] 失败:依赖表违规超出基线。')
  for (const failure of failures) console.error(`  - ${failure}`)
}

if (stale.length > 0) {
  console.error(
    '[ui-hook-deps] 失败:基线里有已经消失的违规(棘轮只准缩小,修完必须收紧基线)。' +
      '请跑 `node scripts/ui/check/reactHookDeps.mjs --update`。',
  )
  for (const item of stale) console.error(`  - ${item}`)
}

if (unregisteredWarnRules.length > 0) {
  console.error(
    '[ui-hook-deps] 失败:eslint 配置出现未登记的 warn 级规则。' +
      '`bun run lint` 走 --quiet 只收 error,warn 会被静默吞掉——' +
      '要么把规则提到 error,要么在本探针的 AllowedWarnRules 里登记并配好棘轮。',
  )
  for (const ruleId of unregisteredWarnRules) console.error(`  - ${ruleId}`)
}

if (failures.length > 0 || stale.length > 0 || unregisteredWarnRules.length > 0) process.exit(1)

console.log(
  `[ui-hook-deps] 通过。${RuleId} 存量 ${total} 条 / ${Object.keys(counts).length} 个文件,与基线一致。`,
)
