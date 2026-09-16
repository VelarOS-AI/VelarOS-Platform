import { createHash } from 'node:crypto'
import { basename } from 'node:path'

import { first, trimmedStringOrEmpty } from '@velaros-ai/core'

import type { MemoryEvidenceCategory, MemoryEvidenceRecord } from '../../types/memory'
import type { MemoryConceptDescriptor } from '../../types/tree'

/** 取一段文本的 sha256 十六进制摘要：稳定 id 与各种指纹都从它来。 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 由一段稳定文本派生一个带前缀的确定性 id：同样的输入永远得到同一个 id。 */
export function stableId(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).slice(0, 24)}`
}

/**
 * 把一段身份文本归一成 stable_key 的材料：NFKC + 小写，保留字母数字与 `+ # .`，其余折叠成单空格。
 * 保留区分性符号是有意的：旧实现剥掉全部标点，会让 C++ / C# / C 归一成同一个键而被错误合并。
 */
export function normalizeIdentityText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim()
}

/** 折叠空白后截到指定字数，截断处补省略号。 */
export function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

/** 从证据的 metadata 里读一个字符串字段；不是字符串或空白时给空串。 */
export function readMetadataString(evidence: MemoryEvidenceRecord, key: string): string {
  return trimmedStringOrEmpty(evidence.metadata[key])
}

/** 给一条证据挑一个展示标题：自带标题优先，其次会话标题，再次正文首行，都没有就用占位名。 */
export function evidenceTitle(evidence: MemoryEvidenceRecord): string {
  return (
    evidence.title.trim() ||
    readMetadataString(evidence, 'sessionTitle') ||
    truncate(first(evidence.content.split('\n')) ?? evidence.content, 72) ||
    '未命名记忆'
  )
}

/**
 * 判定一条证据该归到哪个概念：给出概念类型、展示名与参与 stable_key 的区分串。
 * 带工作区的证据往项目/任务上靠，其余按类别走；区分串决定同一个概念会不会被合并。
 */
export function resolveConceptDescriptor(evidence: MemoryEvidenceRecord): MemoryConceptDescriptor {
  const title = evidenceTitle(evidence)
  const projectName = evidence.workspaceRoot ? basename(evidence.workspaceRoot) : ''
  switch (evidence.category) {
    case 'preference':
      return { type: 'user', name: '用户偏好', stableDiscriminator: 'user:preferences' }
    case 'feedback':
      return { type: 'user', name: '协作方式', stableDiscriminator: 'user:collaboration' }
    case 'interest':
      return { type: 'interest', name: title, stableDiscriminator: title }
    case 'procedure':
      return { type: 'procedure', name: title, stableDiscriminator: title }
    case 'goal':
      return { type: 'goal', name: title, stableDiscriminator: title }
    case 'task':
      return {
        type: 'task',
        name: title,
        stableDiscriminator: readMetadataString(evidence, 'taskKey') || title,
      }
    case 'project':
      return {
        type: 'project',
        name: projectName || title,
        stableDiscriminator: evidence.workspaceRoot || title,
      }
    case 'entity':
      return { type: 'entity', name: title, stableDiscriminator: title }
    case 'artifact':
      return { type: 'artifact', name: title, stableDiscriminator: title }
    case 'conversation': {
      const sessionTitle = readMetadataString(evidence, 'sessionTitle')
      if (evidence.workspaceRoot) return {
          type: 'task',
          name: sessionTitle || title,
          stableDiscriminator: evidence.sessionId || sessionTitle || title,
        }
      return {
        type: 'conversation',
        name: sessionTitle || title,
        stableDiscriminator: evidence.sessionId || sessionTitle || title,
      }
    }
    case 'fact':
    default:
      if (evidence.workspaceRoot) return {
          type: 'project',
          name: projectName || title,
          stableDiscriminator: evidence.workspaceRoot,
        }
      return { type: 'entity', name: title, stableDiscriminator: title }
  }
}

/** 证据类别到主张谓词的名单：谓词是召回按类别过滤的钥匙，改名单等于改召回口径。 */
export function predicateForCategory(category: MemoryEvidenceCategory): string {
  const predicates: Record<MemoryEvidenceCategory, string> = {
    conversation: 'conversation_observation',
    fact: 'has_fact',
    preference: 'prefers',
    feedback: 'collaboration_feedback',
    procedure: 'uses_procedure',
    project: 'works_on',
    task: 'performs_task',
    goal: 'pursues_goal',
    interest: 'interested_in',
    entity: 'knows_entity',
    artifact: 'produces_artifact',
  }
  return predicates[category]
}

/** 按来源可信度给一条证据派生的主张定基础置信度：用户亲口说的最高，外部内容最低。 */
export function confidenceForEvidence(evidence: MemoryEvidenceRecord): number {
  switch (evidence.trustLevel) {
    case 'user_stated':
      return 0.96
    case 'system_observed':
      return 0.88
    case 'agent_derived':
      return 0.68
    case 'external_content':
      return 0.42
  }
}

/** 按来源可信度给主张定认识状态：用户确认、观察所得，还是推断出来的。 */
export function epistemicStatusForEvidence(evidence: MemoryEvidenceRecord): string {
  switch (evidence.trustLevel) {
    case 'user_stated':
      return 'user_confirmed'
    case 'system_observed':
      return 'observed'
    case 'agent_derived':
    case 'external_content':
      return 'inferred'
  }
}

/** 按类别权重加可信度加成算显著度：显著度决定衰减半衰期，也是概念与经历的初始激活度。 */
export function salienceForEvidence(evidence: MemoryEvidenceRecord): number {
  const categoryWeight: Record<MemoryEvidenceCategory, number> = {
    conversation: 0.46,
    fact: 0.62,
    preference: 0.82,
    feedback: 0.86,
    procedure: 0.72,
    project: 0.76,
    task: 0.7,
    goal: 0.88,
    interest: 0.68,
    entity: 0.58,
    artifact: 0.66,
  }
  return Math.min(1, categoryWeight[evidence.category] + (evidence.trustLevel === 'user_stated' ? 0.06 : 0))
}
