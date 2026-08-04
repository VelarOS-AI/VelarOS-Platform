#!/usr/bin/env bun
// 用途:共享基础层(@velaros-ai/core)的领域语义词汇墙。基线=零违规。
//
// Core 只能提供无领域语义、可被任意包复用的 primitives。Agent、Kernel 与各能力域
// 都是 Core 的消费者，不能反向进入 Core 的类型、常量或运行时实现。
//
// 两条规则:
//  ① 硬墙(零迁移清单):packages/core/src/** 出现产品域词即红。
//  ② 同名不同义豁免必须逐条写理由，按词形而不是按文件豁免。
//
// 有意的新增域语义 = 违反 §15.4,不提供 baseline 逃生门:要么改代码,要么改宪章。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(HERE, '../..')
const CoreSourceRoot = resolve(RepoRoot, 'packages/core/src')

/** 具体域名词。命中即「Core 认识了这个域」。 */
const DomainWords = [
  'agent',
  'kernel',
  'chat',
  'browser',
  'workspace',
  'memory',
  'office',
  'computer',
  'project',
  'game',
]

/**
 * 域词匹配是命名风格感知的:`chatStorage` / `ChatSession` / `resolveChatSendRequest` /
 * `CHAT_STORAGE_SCHEMA_VERSION` 全算命中,而 `chatty` 这类「词形延续」不算
 * (域词必须是一个完整的标识符片段)。
 */
function domainWordPattern(word) {
  const capitalized = word[0].toUpperCase() + word.slice(1)
  const screaming = word.toUpperCase()
  return new RegExp(
    `(?:(?<![A-Za-z])(?:${word}|${capitalized}|${screaming})|(?<=[a-z0-9])${capitalized})(?![a-z])`,
    'u',
  )
}

const DomainWordPatterns = DomainWords.map((word) => [word, domainWordPattern(word)])

/**
 * 规则③ 同名不同义豁免——按词形豁免,逐条写清为什么它不是域词。
 * 新增豁免必须在这里留下理由;没有理由的豁免不许存在。
 */
const SenseExemptions = [
  {
    // `InMemoryKernelStateBackend` / `MemoryTransport` / `createMemoryTransport` / id 'memory'
    pattern: /(?:in[-_]?memory|memory\s*transport)/iu,
    reason: 'memory=RAM(进程内存/内存日志 transport),不是 VelarOS 记忆能力域',
  },
  {
    pattern: /id:\s*options\.id\s*\?\?\s*'memory'/u,
    reason: "内存 transport 的默认 id 字面量 'memory',同上",
  },
  {
    pattern: /\|\s*'browser'|return\s+'browser'/u,
    reason: 'browser=JS 运行环境标签(window/document 存在与否),不是 VelarOS 浏览器能力域',
  },
]

const SourceExtensions = new Set(['.ts', '.tsx'])

function collectSourceFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full))
      continue
    }
    if (full.endsWith('.d.ts')) continue
    const dot = full.lastIndexOf('.')
    if (dot >= 0 && SourceExtensions.has(full.slice(dot))) out.push(full)
  }
  return out
}

function normalizeSeparators(pathText) {
  return pathText.split('\\').join('/')
}

function exemptSense(line) {
  return SenseExemptions.some((exemption) => exemption.pattern.test(line))
}

function scanFile(file) {
  const hits = []
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (exemptSense(line)) return
    for (const [word, pattern] of DomainWordPatterns) {
      if (!pattern.test(line)) continue
      hits.push({ line: index + 1, word, text: line.trim().slice(0, 120) })
      break
    }
  })
  return hits
}

function main() {
  const violations = []

  for (const file of collectSourceFiles(CoreSourceRoot)) {
    const relativeFile = normalizeSeparators(relative(CoreSourceRoot, file))
    const hits = scanFile(file)
    if (hits.length === 0) continue
    for (const hit of hits) {
      violations.push(
        `packages/core/src/${relativeFile}:${hit.line}: core 出现领域词「${hit.word}」:${hit.text}`,
      )
    }
  }

  if (violations.length > 0) {
    console.error(`[core-semantic-vocabulary] 失败:${violations.length} 条违规:`)
    for (const message of violations) console.error(`  ${message}`)
    console.error(
      '\n判据:只有无领域语义、能被任意包复用的 primitive 才能留在 Core。',
    )
    process.exit(1)
  }

  console.log(
    '[core-semantic-vocabulary] 通过。Core 源码零产品领域语义。',
  )
}

main()
