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
import { compareStableStrings } from './determinism'

/** 单条记录保留的锚点上限：超过即噪声，且锚点本身也占预算。 */
export const MaxContextAnchors = 24

/**
 * 锚点抽取的输入窗口上限。
 *
 * 工具输出可以是 MB 级（准入照样要算 bytes.full 与锚点，即便下一步就被摘录成 24K），对全文跑
 * 六条全局正则会在主进程上卡出可感知的准入延迟。按**头尾各半**取窗口与摘录本身的头尾口径一致：
 * 有价值的关键场（命令、路径、退出码）几乎都落在开头与结尾，中段是重复的日志体。
 */
const MaxAnchorScanChars = 128_000

/**
 * 锚点类别（抽取顺序即信息密度降序）。
 *
 * 类别在准入期就已知（是哪条正则抽出来的），过去却在记录上退化成无类型字符串，骨架只好用一条更
 * 弱的正则二次分类——`0.24.0` 因此被当成文件路径塞进「文件」栏，把真实路径全顶掉（审计 V13）。
 */
export type ContextAnchorKind = 'path' | 'command' | 'identifier' | 'number'

/** 类别优先序：截断与分栏一律按它，不按 UTF-16 码元序（数字恒排在字母前是纯偶然）。 */
export const ContextAnchorKindOrder: readonly ContextAnchorKind[] = [
  'path',
  'command',
  'identifier',
  'number',
]

export interface ContextAnchor {
  /** 归一后的锚点正文（比对与去重都在归一形上做）。 */
  text: string
  kind: ContextAnchorKind
}

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

/** 验证 / 构建命令锚（逐字沿用 v1）。 */
const CommandAnchorPatterns = [
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?[A-Za-z0-9_./:-]+(?:\s+[A-Za-z0-9_./:=@-]+){0,5}/g,
  /\b(?:pytest|jest|vitest|tsc|cargo\s+test|go\s+test)\b(?:\s+[A-Za-z0-9_./:=@-]+){0,5}/g,
]

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
const NumberAnchorPatterns = [
  /\b(?:exit(?:\s+code)?|status|code|port|line|row|column|offset|退出码|端口|行)\s*[:=#]?\s*\d+\b/gi,
  /\bv?\d+\.\d+(?:\.\d+)+\b/g,
  /\b\d{3,}\b/g,
]

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

  for (const pattern of CommandAnchorPatterns) {
    for (const match of scanned.matchAll(pattern)) addAnchor(trimCommandAnchor(match[0]), 'command')
  }

  for (const match of scanned.matchAll(IdentifierAnchorPattern)) addAnchor(match[0], 'identifier')

  for (const pattern of NumberAnchorPatterns) {
    for (const match of scanned.matchAll(pattern)) addAnchor(match[0], 'number')
  }

  return anchors.slice(0, Math.max(0, limit))
}

/** 抽取窗口：超长文本只扫头尾各半，中段（重复日志体）不进正则。 */
function sliceAnchorScanWindow(text: string): string {
  if (text.length <= MaxAnchorScanChars) return text

  const half = Math.floor(MaxAnchorScanChars / 2)
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

function trimCommandAnchor(value: string): string {
  const normalized = normalizeAnchorText(value).replace(/[.,;，。；]+$/g, '')
  const tokens = normalized.split(' ').filter(Boolean)
  if (tokens.length <= 2) return normalized

  const first = tokens[0]?.toLowerCase()
  const second = tokens[1]?.toLowerCase()
  const minimumCommandTokens =
    first && ['bun', 'npm', 'pnpm', 'yarn'].includes(first) && second === 'run' ? 3 : 2
  const stopIndex = tokens.findIndex(
    (token, index) =>
      index >= minimumCommandTokens &&
      CommandAnchorStopWords.has(token.replace(/[.,;，。；]+$/g, '').toLowerCase())
  )
  const selected = stopIndex >= 0 ? tokens.slice(0, stopIndex) : tokens
  return selected.join(' ').replace(/[.,;，。；]+$/g, '')
}
