#!/usr/bin/env bun
// 用途:内核基础层(@velaros-ai/core)的**领域语义词汇墙**。基线=零新违规。
//
// 法理:宪章 §15.4 裁决三「领域语义逐出 core」+ §2 入核判据(pi 判据:存在至少一个合法产品
// 不需要它)。内核一旦认识「聊天/浏览器/工作区/记忆/办公/桌面控制」这类**具体域名词**,
// Ring 0 冻结区就名存实亡——它只该认识「模块/能力/权限/事件/状态/引用/错误」。
// 与 agent 仓先例 `agent-runtime-concrete-semantic-vocabulary` 同一把尺,方向相反:
// 那道墙禁 agent 主干认识具体能力,这道墙禁内核认识任何域。
//
// 三条规则:
//  ① 硬墙(零豁免):packages/core/src/kernel/** 是内核本体,出现任何域词即红,不接受登记。
//  ② 待逐出清单(只减不增):core 里尚未搬走的域语义文件逐条登记 + 写明去向;
//     清单外的文件出现域词即红。清单里的文件被清干净后必须从清单删除(留着即红),
//     这就是「只减不增」的机械形状——它只会缩短,不会变长。
//  ③ 同名不同义豁免(逐条写理由):词形撞车但不是 VelarOS 域词的,按 **词形** 而不是按文件豁免。
//
// 有意的新增域语义 = 违反 §15.4,不提供 baseline 逃生门:要么改代码,要么改宪章。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(HERE, '../..')
const CoreSourceRoot = resolve(RepoRoot, 'packages/core/src')
const KernelRoot = resolve(CoreSourceRoot, 'kernel')

/** 具体域名词。命中即「内核认识了这个域」。 */
const DomainWords = ['chat', 'browser', 'workspace', 'memory', 'office', 'computer']

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

/**
 * 规则② 待逐出清单。key=相对 packages/core/src 的路径,value=去向与判据。
 *
 * 判据(宪章 §15.4「去留判据」):类型或行为里出现域名词的出核。
 *  - **数据契约** → `@velaros-ai/agent/protocol`
 *  - **运行时行为** → `@velaros-ai/agent`
 * 清单是 P2 未做完的余量,不是长期豁免:每搬走一个就从这里删一行,清单归零即墙全面生效。
 */
const EvictionQueue = new Map([
  ['types/index.ts', 'agent/protocol —— 聊天/执行/IPC 事件载荷全集(1.3k 行),core 里最大的一块域语义'],
  ['types/chatRuntime.ts', 'agent/protocol —— 聊天运行态数据契约'],
  ['types/agent.ts', 'agent/protocol —— agent 会话/回合数据契约'],
  ['types/tool.ts', 'agent/protocol —— 工具调用数据契约'],
  ['types/storage.ts', 'agent/protocol —— 会话存储数据契约'],
  ['types/turnContext.ts', 'agent/protocol —— 回合上下文数据契约'],
  ['constants/chatStorage.ts', 'agent/protocol —— 会话存储布局常量'],
  ['constants/promptFeatures.ts', 'agent/protocol —— 提示词特性开关常量'],
  ['constants/typedFieldAsserts.ts', 'agent/protocol —— 聊天字段断言器'],
  ['utils/resolveStoredChatSession.ts', 'agent —— 会话读取归一化行为'],
  ['utils/resolveChatSendRequest.ts', 'agent —— 发送请求归一化行为'],
])

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
  const queueHitFiles = new Set()

  for (const file of collectSourceFiles(CoreSourceRoot)) {
    const relativeFile = normalizeSeparators(relative(CoreSourceRoot, file))
    const hits = scanFile(file)
    if (hits.length === 0) continue

    const insideKernel = file.startsWith(`${KernelRoot}/`)
    if (insideKernel) {
      for (const hit of hits) {
        violations.push(
          `packages/core/src/${relativeFile}:${hit.line}: 内核本体出现域词「${hit.word}」(硬墙零豁免):${hit.text}`,
        )
      }
      continue
    }

    if (EvictionQueue.has(relativeFile)) {
      queueHitFiles.add(relativeFile)
      continue
    }

    const first = hits[0]
    violations.push(
      `packages/core/src/${relativeFile}:${first.line}: core 出现具体域词「${first.word}」(共 ${hits.length} 处):${first.text}`,
    )
  }

  // 只减不增:清单里已经清干净的文件必须删掉,否则清单会变成僵尸豁免。
  for (const [relativeFile, destination] of EvictionQueue) {
    if (queueHitFiles.has(relativeFile)) continue
    violations.push(
      `待逐出清单里的 packages/core/src/${relativeFile} 已无域词(或文件已不在)——请从 EvictionQueue 删除该行(去向:${destination})。`,
    )
  }

  if (violations.length > 0) {
    console.error(`[core-semantic-vocabulary] 失败:${violations.length} 条违规:`)
    for (const message of violations) console.error(`  ${message}`)
    console.error(
      '\n判据(宪章 §15.4):只认识「模块/能力/权限/事件/状态/引用/错误」的才留在内核基础层;'
      + '认识具体域名词的一律出核——数据契约去 agent/protocol,运行时行为去 agent 或对应域包。',
    )
    process.exit(1)
  }

  console.log(
    `[core-semantic-vocabulary] 通过。内核本体(kernel/**)零域词;core 其余源码 0 条新违规`
    + `(${EvictionQueue.size} 个文件在待逐出清单,只减不增)。`,
  )
}

main()
