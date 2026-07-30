/**
 * 锚点规则抽取（上下文治理 v2 · 准入期一次性、零 LLM）。
 *
 * 判决依据：压缩老化研究实测 LLM 摘要**最先丢数字/路径/专名**——恰恰是后续执行唯一能对齐的
 * 硬事实。所以这些"关键场"必须在准入时用规则抽走并逐字留在记录元数据里，后续 I1 骨架与 I2
 * 蒸馏的锚点验证都读这一份，不再各抽各的。
 *
 * 语义来源：v1 `history/compaction.ts` 的 `FileAnchorPattern` / `CommandAnchorPatterns` /
 * `CommandAnchorStopWords`（那套正则在真机上是好的，逐字吸收）；v2 追加数字锚与标识符锚——
 * v1 只抽路径与命令，退出码/端口/行号/符号名靠 LLM 记，正是老化最快的一档。
 *
 * 依赖纪律：不 import v1 压缩模块（B1 判死），正则在本文件单源。
 */
import { sortedUniqueStrings } from './determinism'

/** 单条记录保留的锚点上限：超过即噪声，且锚点本身也占预算。 */
export const MaxContextAnchors = 24

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
export function extractContextAnchors(text: string, limit: number = MaxContextAnchors): string[] {
  if (!text.trim()) return []

  const anchors: string[] = []
  const seen = new Set<string>()
  const addAnchor = (raw: string): void => {
    const normalized = normalizeAnchorText(raw)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    anchors.push(normalized)
  }

  for (const match of text.matchAll(FileAnchorPattern)) addAnchor(match[0])

  for (const pattern of CommandAnchorPatterns) {
    for (const match of text.matchAll(pattern)) addAnchor(trimCommandAnchor(match[0]))
  }

  for (const match of text.matchAll(IdentifierAnchorPattern)) addAnchor(match[0])

  for (const pattern of NumberAnchorPatterns) {
    for (const match of text.matchAll(pattern)) addAnchor(match[0])
  }

  return anchors.slice(0, Math.max(0, limit))
}

/**
 * 锚点密度：每千字符的锚点数。I0 逐出排序与 I2 蒸馏选段的输入信号
 * （叙事密度高、锚点密度低的段落才值得花一次 LLM）。
 */
export function anchorDensityPerKiloChar(anchorCount: number, chars: number): number {
  if (chars <= 0) return 0
  return (anchorCount * 1000) / chars
}

/** 锚点集合的稳定并集：多条记录合并成骨架时用（去重 + 码元序）。 */
export function mergeAnchors(...groups: ReadonlyArray<readonly string[]>): string[] {
  return sortedUniqueStrings(groups.flat())
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
