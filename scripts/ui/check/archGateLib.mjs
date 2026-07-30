#!/usr/bin/env node
// 用途:§12.9 组件形态封闭两门(uiComponentFormClosure / uiColorLiteralClosure)的共享底座——
// 文件收集 / 注释剥离 / 棘轮基线读写与报告。两门自 monorepo arch-guard-velaros 随 U2 拆仓退役
// (指纹基线型棘轮门无法改读 sibling),按「各仓自持自己的质量门」判例收编进本仓自持。
//
// 棘轮语义:门以现状为基线(baselines/ui/<rule>-baseline.json 冻结存量违规),新增违规即红,存量修复
// 后基线条目自然 stale(不阻塞)。有意扩基线:VELAROS_UI_GATE_BASELINE_UPDATE=1 node scripts/ui/check/<门>.mjs。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const RepoRoot = resolve(HERE, '../../..')
export const UiSourceDir = resolve(RepoRoot, 'packages/ui/src')
export const UpdateBaseline = process.env.VELAROS_UI_GATE_BASELINE_UPDATE === '1'

const SkipDirNames = new Set(['node_modules', 'dist', 'out', 'build'])

export function collectFiles(dir, extensions) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (SkipDirNames.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      out.push(...collectFiles(full, extensions))
      continue
    }
    const dot = full.lastIndexOf('.')
    if (dot >= 0 && extensions.has(full.slice(dot))) out.push(full)
  }
  return out
}

// 构建产物(`scripts/ui/build/*.mjs` 产出的 `*.generated.*`)不进任何门的扫描面:它由源文件推导,
// 把它的违规钉进人工基线等于「重新生成即红」,而真正该记账的源文件反倒可能在面外。只记账源。
export function isGeneratedArtifact(file) {
  return /\.generated\.[^./\\]+$/.test(file)
}

export function isInsideDirectory(file, dir) {
  const candidate = relative(dir, file)
  return (
    candidate === '' ||
    (candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate))
  )
}

export function toRelativePath(file) {
  const candidate = relative(RepoRoot, file)
  const resolved =
    candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate)
      ? candidate
      : file
  return resolved.replaceAll('\\', '/')
}

// 把匹配段替换为等长空白(保留换行),使行号与列位不漂移。
function blankOut(source, pattern) {
  return source.replace(pattern, (segment) => segment.replace(/[^\n]/g, ' '))
}

export function stripCssComments(source) {
  return blankOut(source, /\/\*[\s\S]*?\*\//g)
}

export function stripTsComments(source) {
  return blankOut(blankOut(source, /\/\*[\s\S]*?\*\//g), /\/\/[^\n]*/g)
}

function baselinePath(rule) {
  return resolve(RepoRoot, 'baselines', 'ui', `${rule}-baseline.json`)
}

function loadBaseline(rule) {
  const path = baselinePath(rule)
  if (!existsSync(path)) return new Set()
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return new Set(parsed.fingerprints ?? [])
}

/**
 * 棘轮执行器。entries: [{ fingerprint, message }]。返回是否通过(true=绿)。
 * UpdateBaseline 模式重写基线并返回 true。
 */
export function runRatchet(rule, title, entries) {
  const fingerprints = [...new Set(entries.map((e) => e.fingerprint))].sort()

  if (UpdateBaseline) {
    mkdirSync(resolve(RepoRoot, 'baselines', 'ui'), { recursive: true })
    writeFileSync(
      baselinePath(rule),
      `${JSON.stringify(
        {
          version: 1,
          rule,
          purpose: `${title}(内核宪章 §12.9)存量违规基线;棘轮只减不增,新增即红。`,
          generatedAt: new Date().toISOString(),
          fingerprints,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`[${rule}] baseline 已重生成:${fingerprints.length} 条冻结指纹。`)
    return true
  }

  const baseline = loadBaseline(rule)
  const fresh = entries.filter((e) => !baseline.has(e.fingerprint))
  const exempt = fingerprints.length

  if (fresh.length === 0) {
    console.log(
      `[${rule}] 通过。${title}:0 条新违规${exempt > 0 ? `(${exempt} 条存量入基线冻结)` : '(现状零违规)'}。`,
    )
    return true
  }

  console.error(`[${rule}] 失败:${fresh.length} 条新违规(§12.9 棘轮只减不增):`)
  for (const e of fresh) console.error(`  ${e.message}`)
  console.error(
    `\n若为有意的形态/令牌变化,修复违规;确需入基线时 VELAROS_UI_GATE_BASELINE_UPDATE=1 node scripts/ui/check/${rule === 'ui-component-form-closure' ? 'uiComponentFormClosure' : 'uiColorLiteralClosure'}.mjs 重生成并在提交信息说明。`,
  )
  return false
}
