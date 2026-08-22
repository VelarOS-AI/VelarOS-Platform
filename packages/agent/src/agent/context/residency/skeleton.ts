/**
 * I1 规则骨架（上下文治理 v2 · §4B 第二档器械，零 LLM、零时钟、零随机）。
 *
 * 判决依据（设计 §11 裁决 3）：v1 六字段摘要格式**是好的**，所以格式语义整体复制进来；但当时
 * **禁 import** `history/sections` 与 `history/compaction`——那两个模块在生死簿上判死，import
 * 等于让死刑模块靠一根引用续命（`history/compaction.ts` 已于 B1c 删除，
 * `history/sections.ts` 连同 `summary.ts`/`highlights.ts` 已于死代码清理批删除，这条纪律因此兑现）。
 * 这里是自持实现，正则与分段常量在本文件单源。
 *
 * 与 v1 的两处实质差异（都是 P3「机械优先」的直接后果）：
 *  ① **anchors 逐字并入**。v1 的锚点只在语义摘要的事后校验里出现（LLM 已经把数字丢了才发现）；
 *     v2 的锚点在准入期就抽好，骨架直接把它们逐字写进 文件 / 命令 / 锚点 三栏——先保住再说。
 *  ② **带无损指针**（P5）。骨架末行列出成员的召回引用，被折叠的内容随时能按 ref 取回；
 *     v1 的规则摘要是纯有损文本，折进去的东西再也拿不回来。
 */
import { isArray, isEmpty, isFiniteNumber, isObject, isString } from '@velaros-ai/core'

import {
  compareContextAnchors,
  type ContextAnchor,
  normalizeAnchorText,
  toContextAnchorTexts,
} from './anchors'
import type { ContextRecord } from './ContextRecord'
import { DefaultContextGovernanceConfig } from './governanceConfig'

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
/**
 * 锚点行的默认条数上限。
 *
 * 单源取 `distillation.maxRequiredAnchors`：真正兑现"锚点逐字保住"的就是这条机械生成的锚点行，
 * 而蒸馏又要求模型在正文里逐字复现 `maxRequiredAnchors` 条。两个常量各定各的（16 vs 24）等于
 * 多出来的 8 条既抬高拒收概率、又根本没进最终产物——两头不讨好。
 */
const DefaultMaxSkeletonAnchors = DefaultContextGovernanceConfig.distillation.maxRequiredAnchors
/** 每份摘要最多代表的记录数；每个成员都必须在产物里留下精确召回指针。 */
export const MaxContextSummaryMembers = 12
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

export interface ContextSkeletonInput {
  /** 被折叠的成员记录（账本序）。 */
  members: readonly ContextRecord[]
  /** 本次 epoch 号（进骨架头，便于在转录里定位是哪一次折叠产生的）。 */
  epoch: number
  /** 锚点行条数上限；缺省取 `distillation.maxRequiredAnchors` 的默认值。 */
  maxAnchors?: LooseOptional<number>
}

export interface ContextSkeletonResult {
  text: string
  /** 逐字并入骨架的锚点（去重，按类别优先序）。 */
  anchors: ContextAnchor[]
  /** 骨架代表的成员记录 id（无损指针的账本侧身份）。 */
  memberIds: string[]
}

/**
 * 生成规则骨架。members 为空或抽不出任何字段时返回 null —— 空骨架比没有骨架更糟：
 * 它既占预算又让模型以为"这里已经总结过了"。
 */
export function buildContextSkeleton(input: ContextSkeletonInput): Nullable<ContextSkeletonResult> {
  const members = [...input.members]
    .sort((left, right) => left.seq - right.seq)
    .slice(0, MaxContextSummaryMembers)
  if (isEmpty(members)) return null

  const anchors = collectContextAnchorUnion(members)
  const fields = collectSkeletonFields(members, anchors)
  const lines = SkeletonFieldOrder.map((field) => renderSkeletonField(field, fields[field])).filter(
    (line): line is string => Boolean(line)
  )
  if (isEmpty(lines) && isEmpty(anchors)) return null

  const memberIds = members.map((member) => member.id)
  const anchorLine = renderContextAnchorLine(
    toContextAnchorTexts(anchors),
    isFiniteNumber(input.maxAnchors) ? input.maxAnchors : DefaultMaxSkeletonAnchors
  )
  const recallLine = renderContextRecallLine(members)
  const header = `${SkeletonHeaderPrefix} epoch=${input.epoch} members=${members.length}]`
  const body = [header, ...lines, anchorLine]
    .filter((line): line is string => Boolean(line))
    .join('\n')
  const text = clampSkeletonText(body, recallLine)

  return { text, anchors, memberIds }
}

/** 骨架文本的识别谓词（转录展示与后续 epoch 的"别再折叠骨架"判据共用）。 */
export function isContextSkeletonText(value: string): boolean {
  return value.trimStart().startsWith(SkeletonHeaderPrefix)
}

/**
 * 成员锚点并集（归一 + 去重 + **类别优先序**）。
 *
 * I1 骨架与 I2 蒸馏共用同一份：锚点在准入期就抽好存在记录元数据上，两档器械读的必须是同一批，
 * 否则"蒸馏产物少了哪个锚点"这个判断会拿另一套口径去问。
 *
 * 排序按 `路径 → 命令 → 标识符 → 数字`：并集要被截到上限，按 UTF-16 码元序排等于优先保住以数字
 * 开头的锚点（'0'-'9' 恒在字母与中文之前），把最该逐字保住的文件路径和构建命令挤出去（审计 V13）。
 */
export function collectContextAnchorUnion(members: readonly ContextRecord[]): ContextAnchor[] {
  const seen = new Map<string, ContextAnchor>()
  for (const member of members) {
    for (const anchor of member.anchors) {
      const text = normalizeAnchorText(anchor.text)
      if (text && !seen.has(text)) seen.set(text, { text, kind: anchor.kind })
    }
  }

  return [...seen.values()].sort(compareContextAnchors)
}

/** 锚点行（I1/I2 共用）。空集不写空行——一条只有标签的行是纯噪声。 */
export function renderContextAnchorLine(
  anchors: readonly string[],
  maxAnchors: number = DefaultMaxSkeletonAnchors
): Nullable<string> {
  if (isEmpty(anchors) || maxAnchors <= 0) return null

  return `- 锚点：${anchors.slice(0, maxAnchors).join(' | ')}`
}

/**
 * 无损指针行（P5，I1/I2 共用）：列出成员里**真能召回**的引用。
 * 纯叙事成员没有 ref，不写空指引——给一个召不回的指针只会换来一次空转召回。
 */
export function renderContextRecallLine(members: readonly ContextRecord[]): Nullable<string> {
  const refs: string[] = []
  const seen = new Set<string>()
  for (const member of members) {
    // 每条账本记录都能由 context:recall 直接按 ctx-r... 读取；payload/tool ref 只是更稳定的跨重建别名。
    const ref = member.excerpt?.ref ?? member.payloadRef ?? member.toolCallId ?? member.id
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
    if (refs.length >= MaxContextSummaryMembers) break
  }
  if (isEmpty(refs)) return null

  return `- 召回：${refs.join(' | ')}（context:recall）`
}

function collectSkeletonFields(
  members: readonly ContextRecord[],
  anchors: readonly ContextAnchor[]
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
  // 类别取准入期抽取时定下的那一份，不再用一条更弱的正则二次分类——那条正则把 `0.24.0` 的 `.0`
  // 当扩展名，版本号因此占满「文件」栏、真实路径一个都进不去（审计 V13）。
  for (const anchor of anchors) {
    if (anchor.kind === 'command') pushSkeletonItem(fields, 'commands', anchor.text)
    else if (anchor.kind === 'path') pushSkeletonItem(fields, 'files', anchor.text)
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
  if (isString(content)) return content
  if (!isArray(content)) return ''

  return content
    .map((part) =>
      isObject(part) && 'text' in part && isString(part.text) ? part.text : ''
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

function clampSkeletonText(body: string, protectedTail: Nullable<string>): string {
  if (!protectedTail) {
    if (body.length <= MaxSkeletonChars) return body
    return `${body.slice(0, MaxSkeletonChars - 1)}…`
  }

  const bodyBudget = Math.max(1, MaxSkeletonChars - protectedTail.length - 1)
  const clampedBody =
    body.length <= bodyBudget ? body : `${body.slice(0, Math.max(0, bodyBudget - 1))}…`
  return `${clampedBody}\n${protectedTail}`
}
