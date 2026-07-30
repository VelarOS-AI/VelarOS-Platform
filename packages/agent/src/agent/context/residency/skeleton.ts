/**
 * I1 规则骨架（上下文治理 v2 · §4B 第二档器械，零 LLM、零时钟、零随机）。
 *
 * 判决依据（设计 §11 裁决 3）：v1 六字段摘要格式**是好的**，所以格式语义整体复制进来；但当时
 * **禁 import** `history/sections` 与 `history/compaction`——那两个模块在生死簿上判死，import
 * 等于让死刑模块靠一根引用续命（`history/compaction.ts` 已于 B1c 删除，这条纪律因此兑现）。
 * 这里是自持实现，正则与分段常量在本文件单源。
 *
 * 与 v1 的两处实质差异（都是 P3「机械优先」的直接后果）：
 *  ① **anchors 逐字并入**。v1 的锚点只在语义摘要的事后校验里出现（LLM 已经把数字丢了才发现）；
 *     v2 的锚点在准入期就抽好，骨架直接把它们逐字写进 文件 / 命令 / 锚点 三栏——先保住再说。
 *  ② **带无损指针**（P5）。骨架末行列出成员的召回引用，被折叠的内容随时能按 ref 取回；
 *     v1 的规则摘要是纯有损文本，折进去的东西再也拿不回来。
 */
import { isEmpty } from '@velaros-ai/core'

import { normalizeAnchorText } from './anchors'
import type { ContextRecord } from './ContextRecord'
import { compareStableStrings } from './determinism'

/** 骨架的六个内容字段（顺序即渲染顺序，逐字沿用 v1 的标签语义）。 */
const SkeletonFieldOrder = ['goal', 'decisions', 'files', 'commands', 'openIssues', 'verification'] as const

export type ContextSkeletonField = (typeof SkeletonFieldOrder)[number]

const SkeletonFieldLabels: Record<ContextSkeletonField, string> = {
  goal: '目标',
  decisions: '决策',
  files: '文件',
  commands: '命令',
  openIssues: '未决',
  verification: '验证',
}

/** 每栏最多条目数（沿用 v1 `SummarySectionMaxItems` 量级）。 */
const SkeletonFieldMaxItems: Record<ContextSkeletonField, number> = {
  goal: 2,
  decisions: 3,
  files: 6,
  commands: 4,
  openIssues: 3,
  verification: 3,
}

/** 单条目最大字符（沿用 v1 `SummarySectionItemLengths` 量级）。 */
const SkeletonItemMaxChars = 220
/** 锚点行最多几条（锚点本身也占预算）。 */
const MaxSkeletonAnchors = 16
/** 召回指针行最多几条。 */
const MaxSkeletonRecallRefs = 12
/** 骨架整体字符上限：骨架自己超预算就不叫压缩了。 */
const MaxSkeletonChars = 3_200

const SkeletonHeaderPrefix = '[context-skeleton'

/** 决策类语句的标志词（中英各一组，逐字命中即入栏）。 */
const DecisionMarkers = [
  '决定',
  '改为',
  '采用',
  '否决',
  '不再',
  '统一',
  '裁决',
  'decided',
  'instead of',
  'we will use',
  'chose',
]

/** 未决 / 阻塞类语句的标志词。 */
const OpenIssueMarkers = [
  '未决',
  '待办',
  '待定',
  '阻塞',
  '失败',
  '报错',
  'todo',
  'fixme',
  'blocked',
  'failed',
  'error:',
  'unresolved',
]

/** 验证类语句的标志词。 */
const VerificationMarkers = [
  '通过',
  '全绿',
  '验证',
  '检查通过',
  'passed',
  'green',
  'exit code 0',
  'all tests',
  'typecheck',
]

/** 命令锚的判据：以已知构建/测试命令开头（与 anchors 的命令正则同一批词）。 */
const CommandAnchorHeads = ['bun', 'npm', 'pnpm', 'yarn', 'pytest', 'jest', 'vitest', 'tsc', 'cargo', 'go']

/** 路径锚的判据：带目录分隔或带已知扩展名。 */
const FileAnchorPattern = /(?:\/|\\)|\.[A-Za-z0-9]{1,10}$/

export interface ContextSkeletonInput {
  /** 被折叠的成员记录（账本序）。 */
  members: readonly ContextRecord[]
  /** 本次 epoch 号（进骨架头，便于在转录里定位是哪一次折叠产生的）。 */
  epoch: number
}

export interface ContextSkeletonResult {
  text: string
  /** 逐字并入骨架的锚点（去重、码元序）。 */
  anchors: string[]
  /** 骨架代表的成员记录 id（无损指针的账本侧身份）。 */
  memberIds: string[]
}

/**
 * 生成规则骨架。members 为空或抽不出任何字段时返回 null —— 空骨架比没有骨架更糟：
 * 它既占预算又让模型以为"这里已经总结过了"。
 */
export function buildContextSkeleton(input: ContextSkeletonInput): Nullable<ContextSkeletonResult> {
  const members = [...input.members].sort((left, right) => left.seq - right.seq)
  if (isEmpty(members)) return null

  const anchors = collectSkeletonAnchors(members)
  const fields = collectSkeletonFields(members, anchors)
  const lines = SkeletonFieldOrder.map((field) => renderSkeletonField(field, fields[field])).filter(
    (line): line is string => Boolean(line)
  )
  if (isEmpty(lines) && isEmpty(anchors)) return null

  const memberIds = members.map((member) => member.id)
  const anchorLine = isEmpty(anchors)
    ? null
    : `- 锚点：${anchors.slice(0, MaxSkeletonAnchors).join(' | ')}`
  const recallLine = renderRecallLine(members)
  const header = `${SkeletonHeaderPrefix} epoch=${input.epoch} members=${members.length}]`
  const text = clampSkeletonText(
    [header, ...lines, anchorLine, recallLine].filter((line): line is string => Boolean(line)).join('\n')
  )

  return { text, anchors, memberIds }
}

/** 骨架文本的识别谓词（转录展示与后续 epoch 的"别再折叠骨架"判据共用）。 */
export function isContextSkeletonText(value: string): boolean {
  return value.trimStart().startsWith(SkeletonHeaderPrefix)
}

function collectSkeletonAnchors(members: readonly ContextRecord[]): string[] {
  const seen = new Set<string>()
  for (const member of members) {
    for (const anchor of member.anchors) {
      const normalized = normalizeAnchorText(anchor)
      if (normalized) seen.add(normalized)
    }
  }

  return [...seen].sort(compareStableStrings)
}

function collectSkeletonFields(
  members: readonly ContextRecord[],
  anchors: readonly string[]
): Record<ContextSkeletonField, string[]> {
  const fields: Record<ContextSkeletonField, string[]> = {
    goal: [],
    decisions: [],
    files: [],
    commands: [],
    openIssues: [],
    verification: [],
  }

  // 锚点逐字入栏：命令锚 → 命令，路径锚 → 文件。其余（标识符 / 数字）留在锚点行。
  for (const anchor of anchors) {
    if (isCommandAnchor(anchor)) pushSkeletonItem(fields, 'commands', anchor)
    else if (FileAnchorPattern.test(anchor)) pushSkeletonItem(fields, 'files', anchor)
  }

  for (const member of members) {
    const text = readRecordSkeletonText(member)
    if (!text) continue

    if (member.kind === 'user' && fields.goal.length < SkeletonFieldMaxItems.goal) {
      pushSkeletonItem(fields, 'goal', firstMeaningfulLine(text))
    }

    for (const line of splitSkeletonLines(text)) {
      const lower = line.toLowerCase()
      if (hasMarker(lower, DecisionMarkers)) pushSkeletonItem(fields, 'decisions', line)
      if (hasMarker(lower, OpenIssueMarkers)) pushSkeletonItem(fields, 'openIssues', line)
      if (hasMarker(lower, VerificationMarkers)) pushSkeletonItem(fields, 'verification', line)
    }
  }

  return fields
}

/**
 * 记录的骨架素材文本。
 *
 * 只读**叙事面**：user / assistant / summary 的正文。工具结果不进骨架 —— 它们要么已被 EXCERPT
 * 摘录（正文另有句柄），要么正被 I0 逐出（正文有墓碑指针），把工具输出再抄一遍进骨架等于同一份
 * 内容在上下文里留三份影子。
 */
function readRecordSkeletonText(record: ContextRecord): string {
  if (record.kind !== 'user' && record.kind !== 'assistant' && record.kind !== 'summary') return ''

  const content = record.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? part.text
        : ''
    )
    .filter(Boolean)
    .join('\n')
}

function splitSkeletonLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter((line) => line.length >= 8)
}

function firstMeaningfulLine(text: string): string {
  const lines = splitSkeletonLines(text)
  return lines[0] ?? text.trim()
}

function hasMarker(lowerLine: string, markers: readonly string[]): boolean {
  return markers.some((marker) => lowerLine.includes(marker))
}

function isCommandAnchor(anchor: string): boolean {
  const head = anchor.split(' ')[0]?.toLowerCase() ?? ''
  return CommandAnchorHeads.includes(head)
}

function pushSkeletonItem(
  fields: Record<ContextSkeletonField, string[]>,
  field: ContextSkeletonField,
  raw: string
): void {
  const normalized = raw.replace(/\s+\|\s+/g, ' / ').replace(/\s+/g, ' ').trim()
  if (!normalized) return

  const item = normalized.length > SkeletonItemMaxChars
    ? `${normalized.slice(0, SkeletonItemMaxChars - 1)}…`
    : normalized
  const bucket = fields[field]
  if (bucket.length >= SkeletonFieldMaxItems[field] || bucket.includes(item)) return

  bucket.push(item)
}

function renderSkeletonField(field: ContextSkeletonField, items: readonly string[]): Nullable<string> {
  if (isEmpty(items)) return null

  return `- ${SkeletonFieldLabels[field]}：${items.join(' | ')}`
}

/** 无损指针行（P5）：列出成员里**真能召回**的引用；纯叙事成员没有 ref，不写空指引。 */
function renderRecallLine(members: readonly ContextRecord[]): Nullable<string> {
  const refs: string[] = []
  const seen = new Set<string>()
  for (const member of members) {
    const ref = member.excerpt?.ref ?? member.payloadRef ?? member.toolCallId
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
    if (refs.length >= MaxSkeletonRecallRefs) break
  }
  if (isEmpty(refs)) return null

  return `- 召回：${refs.join(' | ')}（recall_context）`
}

function clampSkeletonText(text: string): string {
  if (text.length <= MaxSkeletonChars) return text

  return `${text.slice(0, MaxSkeletonChars - 1)}…`
}
