/**
 * 锚点规则抽取（上下文治理 v2 · 准入期一次性、零 LLM）。
 *
 * 判决依据：压缩老化研究实测 LLM 摘要**最先丢数字/路径/专名**——恰恰是后续执行唯一能对齐的
 * 硬事实。所以这些"关键场"必须在准入时用规则抽走并逐字留在记录元数据里，后续 I1 骨架与 I2
 * 蒸馏的锚点验证都读这一份，不再各抽各的。
 *
 * 语义来源：v1 `history/compaction.ts`（已于 B1c 删除）的 `FileAnchorPattern` /
 * `CommandAnchorPatterns` / `CommandAnchorStopWords`（那套正则在真机上是好的，逐字吸收）；
 * v2 追加数字锚与标识符锚——
 * v1 只抽路径与命令，退出码/端口/行号/符号名靠 LLM 记，正是老化最快的一档。
 *
 * 依赖纪律：不 import v1 压缩模块（B1 判死），正则在本文件单源。
 */
import type { ContextAnchor,ContextAnchorKind } from '../../types/residency.js'
import { AgentTuning } from '../tuning'

import { compareStableStrings } from './determinism'

/** 单条记录保留的锚点上限：超过即噪声，且锚点本身也占预算。值在 AgentTuning.residency.maxContextAnchors。 */
export const MaxContextAnchors: number = AgentTuning.residency.maxContextAnchors

// 锚点抽取的输入窗口上限在 AgentTuning.residency.maxAnchorScanChars：
// 工具输出可以是 MB 级（准入照样要算 bytes.full 与锚点，即便下一步就被摘录成 24K），对全文跑
// 六条全局正则会在主进程上卡出可感知的准入延迟。按**头尾各半**取窗口与摘录本身的头尾口径一致：
// 有价值的关键场（命令、路径、退出码）几乎都落在开头与结尾，中段是重复的日志体。

/** 类别优先序：截断与分栏一律按它，不按 UTF-16 码元序（数字恒排在字母前是纯偶然）。 */
export const ContextAnchorKindOrder: readonly ContextAnchorKind[] = [
  'path',
  'command',
  'identifier',
  'number',
]

/** 类别位次（越小越该保住）。 */
export function contextAnchorKindRank(kind: ContextAnchorKind): number {
  const rank = ContextAnchorKindOrder.indexOf(kind)
  return rank < 0 ? ContextAnchorKindOrder.length : rank
}

/** 锚点的稳定序：先类别优先序，同类按码元序（确定性，禁 locale 比较）。 */
export function compareContextAnchors(left: ContextAnchor, right: ContextAnchor): number {
  return (
    contextAnchorKindRank(left.kind) - contextAnchorKindRank(right.kind) ||
    compareStableStrings(left.text, right.text)
  )
}

/** 锚点 → 正文清单（提示词与骨架锚点行都只吃正文）。 */
export function toContextAnchorTexts(anchors: readonly ContextAnchor[]): string[] {
  return anchors.map((anchor) => anchor.text)
}

/** 文件路径 / 文件名锚（逐字沿用 v1）。 */
const FileAnchorPattern =
  /\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|toml|yaml|yml|sql|py|rb|go|rs|java|kt|swift|sh)\b/g

const PackageRunnerCommands = new Set(['bun', 'npm', 'pnpm', 'yarn'])
const DirectVerificationCommands = new Set(['pytest', 'jest', 'vitest', 'tsc'])
const CommandArgumentPattern = /^[A-Za-z0-9_./:=@-]+$/u

/**
 * 剥掉一个 token 外层的包裹字符，还原成裸命令片段：先按 `](` 切掉 Markdown 链接的地址部分（只留链接文字），
 * 再从两端逐个剥反引号、括号、引号、星号、尖括号与句末标点。
 * 命令在正文里几乎总被 `` ` `` 或 `(…)` 裹着，不剥就会抽出 ``` `bun ``` 这种永远比对不上的锚点。
 * 整个 token 全是包裹字符时返回空串。
 */
function unwrapCommandToken(value: string): string {
  const markdownLinkBoundary = value.indexOf('](')
  const token = markdownLinkBoundary >= 0 ? value.slice(0, markdownLinkBoundary) : value
  const openingWrappers = '`([{"\'*<'
  const closingWrappers = '`)]},;"\'*>.'
  let start = 0
  let end = token.length
  while (start < end && openingWrappers.includes(token[start] ?? '')) start += 1
  while (end > start && closingWrappers.includes(token[end - 1] ?? '')) end -= 1
  return token.slice(start, end)
}

/**
 * 判一个（已剥壳的）token 还算不算命令的一部分，用来决定命令锚往后吃到哪里：
 * 形状像命令参数（只含字母数字与 `_./:=@-`）**且**不在散文停止词表里时为真。
 * 停止词那一关是要害：`bun test and then check` 里的 `and` 形状上完全像参数，不拦就会把后半句自然语言拼进命令锚。
 */
function isCommandContinuation(value: string): boolean {
  if (!CommandArgumentPattern.test(value)) return false
  return !CommandAnchorStopWords.has(value.toLowerCase())
}

/**
 * 判这个**未剥壳**的原始 token 是不是已经把包裹结构关上了——含 `](`（Markdown 链接到此为止），
 * 或以反引号 / 右括号 / 右方括号 / 右花括号 / 引号 / 星号 / `>` 结尾。为真就停止继续往后吃 token。
 * 必须看原始 token 而非剥壳后的：剥壳恰好把这些收尾标记去掉了，看剥完的永远判不出边界在哪。
 */
function closesWrappedCommand(value: string): boolean {
  if (value.includes('](')) return true
  const last = value.at(-1)
  return last === '`' || last === ')' || last === ']' || last === '}'
    || last === '"' || last === "'" || last === '*' || last === '>'
}

/**
 * 逐行扫出可验证的命令锚，按出现序返回（可能重复，去重在调用方做）。
 *
 * 只认三类起手式：包管理器（bun/npm/pnpm/yarn，可带 `run`，其后必须再跟一个合法参数）、
 * 直接跑的验证命令（pytest/jest/vitest/tsc，命令名本身就够）、以及 `cargo test` / `go test`。
 * 认出起手式后继续往后吃 token，遇到三件事之一即停：原始 token 关掉了包裹结构、下一个 token 不像参数（或是散文停止词）、
 * 或已经多吃了 5 个 token（硬上限，防止把整句话拼进来）。
 * 不匹配起手式的行直接跳过——宁可漏抽也不抽假命令：锚点是后续摘要必须逐字复现的硬事实，多一条假的就多一次无谓拒收。
 */
function extractCommandAnchors(text: string): string[] {
  const commands: string[] = []
  for (const line of text.split('\n')) {
    const rawTokens = line.trim().split(/\s+/u)
    const tokens = rawTokens.map(unwrapCommandToken)
    for (let index = 0; index < tokens.length; index += 1) {
      const executable = tokens[index] ?? ''
      let requiredEnd = index + 1
      if (PackageRunnerCommands.has(executable)) {
        if (tokens[requiredEnd] === 'run') requiredEnd += 1
        if (!CommandArgumentPattern.test(tokens[requiredEnd] ?? '')) continue
        requiredEnd += 1
      } else if (DirectVerificationCommands.has(executable)) {
        // 可执行文件名本身已经是有效的验证锚点。
      } else if ((executable === 'cargo' || executable === 'go') && tokens[requiredEnd] === 'test') {
        requiredEnd += 1
      } else {
        continue
      }

      let end = requiredEnd
      while (
        !closesWrappedCommand(rawTokens[end - 1] ?? '')
        && end < tokens.length
        && end - requiredEnd < 5
        && isCommandContinuation(tokens[end] ?? '')
      ) {
        end += 1
      }
      commands.push(tokens.slice(index, end).join(' '))
      index = end - 1
    }
  }
  return commands
}

/** 命令锚的散文停止词：命令后面接的自然语言不算命令的一部分（逐字沿用 v1）。 */
const CommandAnchorStopWords = new Set([
  'and',
  'or',
  'then',
  'as',
  'with',
  'before',
  'after',
  'passed',
  'failed',
  'success',
  'succeeded',
  'timed',
  'timeout',
  'it',
  'was',
  'were',
  'is',
  'in',
  'for',
])

/**
 * 数字锚。三类：带语义前缀的数（exit code 1 / port 5173 / line 42）、点分版本号、
 * 三位以上的裸数（计数与规模）。单个裸数字不收——那是噪声。
 */
const SemanticNumberPrefixPattern =
  /\b(?:exit(?:[ \t]+code)?|status|code|port|line|row|column|offset|退出码|端口|行)\b/giu
const NumberAnchorPatterns = [
  /\bv?\d+\.\d+(?:\.\d+)+\b/g,
  /\b\d{3,}\b/g,
]

/**
 * 抽"带语义前缀的数"这一类数字锚（`exit code 1` / `port: 5173` / `行 42`），**连前缀一起**原样收进锚点文本——
 * 光一个 `1` 对后续对齐毫无意义，前缀才是它的语义。
 *
 * 前缀与数字之间必须隔着空白或 `:` `=` `#` 之一，两样都没有就跳过（避免把 `code2x` 这类粘连串误收）；
 * 数字后面若紧跟字母、数字或下划线也跳过——那说明这串数字只是某个标识符的一截，不是独立的值。
 * 抽不到就返回空数组，宁缺勿滥。
 */
function extractSemanticNumberAnchors(text: string): string[] {
  const anchors: string[] = []
  for (const match of text.matchAll(SemanticNumberPrefixPattern)) {
    const start = match.index
    let cursor = start + match[0].length
    let hasWhitespace = false
    while (cursor < text.length && /\s/u.test(text[cursor] ?? '')) {
      hasWhitespace = true
      cursor += 1
    }
    const separator = text[cursor]
    const hasSeparator = separator === ':' || separator === '=' || separator === '#'
    if (hasSeparator) {
      cursor += 1
      while (cursor < text.length && /\s/u.test(text[cursor] ?? '')) cursor += 1
    } else if (!hasWhitespace) {
      continue
    }

    const digitsStart = cursor
    while (cursor < text.length && /\d/u.test(text[cursor] ?? '')) cursor += 1
    if (cursor === digitsStart || /[A-Za-z0-9_]/u.test(text[cursor] ?? '')) continue
    anchors.push(text.slice(start, cursor))
  }
  return anchors
}

/** 标识符锚：snake_case 与多词 PascalCase/camelCase 符号名（单词普通英文不收）。 */
const IdentifierAnchorPattern =
  /\b(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*)\b/g

/** 锚点归一：剥引号、压空白。比对与去重都在归一形上做。 */
export function normalizeAnchorText(value: string): string {
  return value
    .replace(/[`'"“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从一段文本抽锚点。顺序确定：路径 → 命令 → 标识符 → 数字（信息密度降序），
 * 组内按出现序，整体去重后截到 `limit`。同输入必同输出。
 */
export function extractContextAnchors(
  text: string,
  limit: number = MaxContextAnchors
): ContextAnchor[] {
  if (!text.trim()) return []

  const scanned = sliceAnchorScanWindow(text)
  const anchors: ContextAnchor[] = []
  const seen = new Set<string>()
  const addAnchor = (raw: string, kind: ContextAnchorKind): void => {
    const normalized = normalizeAnchorText(raw)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    anchors.push({ text: normalized, kind })
  }

  for (const match of scanned.matchAll(FileAnchorPattern)) addAnchor(match[0], 'path')

  for (const command of extractCommandAnchors(scanned)) addAnchor(trimCommandAnchor(command), 'command')

  for (const match of scanned.matchAll(IdentifierAnchorPattern)) addAnchor(match[0], 'identifier')

  for (const numberAnchor of extractSemanticNumberAnchors(scanned)) addAnchor(numberAnchor, 'number')
  for (const pattern of NumberAnchorPatterns) {
    for (const match of scanned.matchAll(pattern)) addAnchor(match[0], 'number')
  }

  return anchors.slice(0, Math.max(0, limit))
}

/** 抽取窗口：超长文本只扫头尾各半，中段（重复日志体）不进正则。 */
function sliceAnchorScanWindow(text: string): string {
  if (text.length <= AgentTuning.residency.maxAnchorScanChars) return text

  const half = Math.floor(AgentTuning.residency.maxAnchorScanChars / 2)
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`
}

/**
 * 锚点密度：每千字符的锚点数。I0 逐出排序与 I2 蒸馏选段的输入信号
 * （叙事密度高、锚点密度低的段落才值得花一次 LLM）。
 */
export function anchorDensityPerKiloChar(anchorCount: number, chars: number): number {
  if (chars <= 0) return 0
  return (anchorCount * 1000) / chars
}

/**
 * 给抽出来的命令锚做最后一次收边：归一（剥引号、压空白）+ 去掉句末标点（`.,;` 与中文 `，。；` 一并算），
 * 再从第 N 个 token 起找第一个散文停止词，在那里截断。
 * N 的取法：`bun run <脚本名>` 这类必须留满 3 个 token 才开始找（否则 `run` 后面的脚本名会被误当停止词截掉），其余留 2 个。
 * 两个 token 以内的命令原样返回、不做截断——短命令没有被自然语言污染的余地。
 */
function trimCommandAnchor(value: string): string {
  const trimPunctuation = (text: string): string => {
    let end = text.length
    while (end > 0 && '.,;，。；'.includes(text[end - 1] ?? '')) end -= 1
    return text.slice(0, end)
  }
  const normalized = trimPunctuation(normalizeAnchorText(value))
  const tokens = normalized.split(' ').filter(Boolean)
  if (tokens.length <= 2) return normalized

  const first = tokens[0]?.toLowerCase()
  const second = tokens[1]?.toLowerCase()
  const minimumCommandTokens =
    first && ['bun', 'npm', 'pnpm', 'yarn'].includes(first) && second === 'run' ? 3 : 2
  const stopIndex = tokens.findIndex(
    (token, index) =>
      index >= minimumCommandTokens &&
      CommandAnchorStopWords.has(trimPunctuation(token).toLowerCase())
  )
  const selected = stopIndex >= 0 ? tokens.slice(0, stopIndex) : tokens
  return trimPunctuation(selected.join(' '))
}
