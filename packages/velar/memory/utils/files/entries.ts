/**
 * 文件权威层的条目规则：文件名生成、稳定键哈希、查询分词、索引行打分、元数据读取。
 *
 * 这些都是纯规则，不碰实例状态也不碰磁盘；后端只负责按规则读写文件。
 */

import { isArray, isEmpty, isString, isTrue, trimmedStringOrEmpty } from '@velaros-ai/core'

import type { MemoryFileDocument, MemoryIndexEntry } from '../../types/files.js'
import type {
  MemoryEvidenceCategory,
  MemoryEvidenceInput,
  MemoryEvidenceRecord,
  MemoryFilesScopeRoot,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryScopeType,
} from '../../types/memory.js'
import { memoryConceptTypeByCategory } from '../backends.js'
import { redactMemorySecrets } from '../evidence.js'
import { MemoryTuning } from '../tuning.js'

/** 由标题生成条目文件名的主干：非字母数字一律换成连字符，首尾连字符去掉，再按上限截断。 */
export function slugify(value: string): string {
  const replaced = value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  let start = 0
  let end = replaced.length
  while (replaced[start] === '-') start += 1
  while (end > start && replaced[end - 1] === '-') end -= 1
  const normalized = replaced.slice(start, end) || 'memory'
  const limited = normalized.slice(0, MemoryTuning.files.slugMaxChars)
  let limitedEnd = limited.length
  while (limitedEnd > 0 && limited[limitedEnd - 1] === '-') limitedEnd -= 1
  return limited.slice(0, limitedEnd) || 'memory'
}

/** 稳定键的短哈希：同输入同输出、碰撞概率够低即可，不做密码学承诺。 */
export function hashStableKey(value: string): string {
  // 两条 FNV 变体各取 32 位拼接；权威层不靠它做安全判定。
  let h1 = 0x81_1c_9d_c5
  let h2 = 0x01_00_01_93
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01_00_01_93)
    h2 = Math.imul(h2 ^ (code + index), 0x85_eb_ca_6b)
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`
}

/**
 * 查询分词：空白/标点切词，CJK 连续段额外产生 2-gram。
 *
 * 中文不带空格，纯按空白切会把整句当成一个 token 而永不命中；2-gram 是零依赖前提下
 * 最便宜的可用近似。语义匹配由可选的 `memory-vector` 负责，本层提供可靠的词法回退。
 */
export function tokenize(value: string): string[] {
  const lowered = value.toLowerCase()
  const tokens = new Set<string>()
  for (const raw of lowered.split(/[^\p{Letter}\p{Number}]+/u)) {
    if (raw.length === 0) continue
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(raw)) {
      if (raw.length === 1) tokens.add(raw)
      for (let index = 0; index + 1 < raw.length; index += 1) {
        tokens.add(raw.slice(index, index + 2))
      }
      continue
    }
    if (raw.length >= 2) tokens.add(raw)
  }
  return [...tokens]
}

/** 这次召回带不带「要读到全文才判得了」的过滤。带的话读取上限按筛过的算。 */
export function hasContentFilter(options: MemoryRecallOptions): boolean {
  return (
    !isEmpty(options.categories ?? [])
    || !isEmpty(options.excludeSourceTypes ?? [])
    || isTrue(options.excludeConversationObservations)
  )
}

/** 一条索引行对一组查询词的词法得分：标题命中最重，路径次之，摘要最轻。 */
export function scoreIndexEntry(entry: MemoryIndexEntry, tokens: readonly string[]): number {
  const name = entry.name.toLowerCase()
  const description = entry.description.toLowerCase()
  const path = entry.path.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (name.includes(token)) score += 3
    else if (path.includes(token)) score += 2
    else if (description.includes(token)) score += 1
  }
  return score
}

/** frontmatter 的每个值都过一遍打码：摘要、来源、标签同样来自聊天正文。 */
export function redactAttributes(
  attributes: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, redactMemorySecrets(value)]),
  )
}

/** 取正文的第一行非空文本当摘要，按上限截断。 */
export function firstLine(content: string): string {
  return (content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, MemoryTuning.files.firstLineMaxChars) ?? ''
}

/** 从元数据里读一个字符串字段；缺席或不是字符串一律返回空串。 */
export function readMetadataString(
  metadata: LooseOptional<Record<string, unknown>>,
  key: string,
): string {
  const value = metadata?.[key]
  return trimmedStringOrEmpty(value)
}

/** 把元数据里的标签数组拼成 frontmatter 的 `tags` 属性；没有标签就不写这个字段。 */
export function optionalTags(
  metadata: LooseOptional<Record<string, unknown>>,
): Record<string, string> {
  const tags = metadata?.tags
  if (!isArray(tags) || isEmpty(tags)) return {}
  const joined = tags.filter(isString).join(', ')
  return joined ? { tags: joined } : {}
}

/** 条目 id 的分隔符：`<scopeId>::<相对路径>`。scopeId 里可能有 `:`，故用双冒号。 */
export const MemoryFilesEntryIdSeparator = '::'

/** 归档标记写在 frontmatter 的 `status` 字段上。 */
export const MemoryFilesArchivedStatus = 'archived'

/** 把一份条目文档投影成召回结果：文件档没有树投影，路径为空是诚实回答。 */
export function toRecallItem(
  root: MemoryFilesScopeRoot,
  entry: MemoryIndexEntry,
  document: MemoryFileDocument,
  retrievalReason: MemoryRecallItem['retrievalReason'],
): MemoryRecallItem {
  const id = `${root.scopeId}${MemoryFilesEntryIdSeparator}${entry.path}`
  const updatedAt = Number.parseInt(document.attributes.updated ?? '', 10)
  return {
    id,
    claimId: id,
    conceptId: entry.path,
    conceptType: memoryConceptTypeByCategory[document.type] ?? 'entity',
    predicate: 'memory',
    title: document.name || entry.name,
    summary: document.description || entry.description,
    value: document.body,
    scopeType: root.scopeType,
    scopeId: root.scopeId,
    // 权威层的内容是被写下来的原文，不存在树后端那种「由证据推断」的置信度衰减。
    confidence: 1,
    salience: 1,
    activation: document.attributes.status === MemoryFilesArchivedStatus ? 0 : 1,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    snapshotVersion: 0,
    retrievalReason,
    evidenceIds: [id],
    sourceTypes: document.attributes.sourceType
      ? [document.attributes.sourceType as MemoryEvidenceInput['sourceType']]
      : [],
    // 文件后端没有树投影：路径为空是诚实回答，不是缺陷。
    path: [],
  }
}

/** 把一次写入的结果拼成证据记录；拒收时 id 为空串（磁盘上没有这条）。 */
export function toEvidenceRecord(input: {
  input: MemoryEvidenceInput
  scopeType: MemoryScopeType
  scopeId: string
  /** 条目 id；拒收时为空串（磁盘上没有这条）。 */
  id: string
  title: string
  category: MemoryEvidenceCategory
  timestamp: number
  stableKey: string
}): MemoryEvidenceRecord {
  return {
    id: input.id,
    sourceType: input.input.sourceType,
    trustLevel: input.input.trustLevel,
    sourceId: input.stableKey,
    sessionId: input.input.sessionId ?? '',
    executionId: input.input.executionId ?? '',
    workspaceRoot: input.input.workspaceRoot ?? '',
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    occurredAt: input.timestamp,
    title: input.title,
    content: input.input.content,
    category: input.category,
    privacyClass: input.input.privacyClass ?? 'standard',
    eligibilityState: 'active',
    metadata: input.input.metadata ?? {},
    // 文件后端没有全局摄入序列：条目之间没有全序关系。
    ingestSequence: 0,
    createdAt: input.timestamp,
  }
}
