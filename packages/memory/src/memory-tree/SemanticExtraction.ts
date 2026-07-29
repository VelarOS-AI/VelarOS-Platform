import { isPresent } from '@velaros-ai/core'

import type {
  MemoryConceptType,
  MemoryEvidenceCategory,
  MemoryEvidenceRecord,
} from './Types'

const MaxSemanticCandidates = 8
const MaxSemanticClauseChars = 420

type DerivedMemoryCategory = Exclude<MemoryEvidenceCategory, 'conversation'>

interface SemanticConceptDescriptor {
  type: MemoryConceptType
  name: string
  stableDiscriminator: string
}

export interface MemorySemanticCandidate {
  category: DerivedMemoryCategory
  title: string
  content: string
  confidenceScale: number
  descriptor?: SemanticConceptDescriptor
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, maxLength: number): string {
  const normalized = compact(value)
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function semanticClauses(content: string): string[] {
  return content
    .replace(/\r\n?/g, '\n')
    .split(/[\n；;。！？!?]+/u)
    .map((clause) => clause
      .replace(/^[\s>*#\-–—•\d.)、]+/u, '')
      .replace(/^[“”"'‘’]+|[“”"'‘’]+$/gu, '')
      .trim()
    )
    .filter((clause) => clause.length >= 4 && clause.length <= MaxSemanticClauseChars)
}

function titleFor(category: DerivedMemoryCategory, value: string): string {
  const labels: Record<DerivedMemoryCategory, string> = {
    fact: '画像',
    preference: '偏好',
    feedback: '协作反馈',
    procedure: '方法',
    project: '项目',
    task: '任务',
    goal: '目标',
    interest: '兴趣',
    entity: '实体',
    artifact: '成果',
  }
  return `${labels[category]}：${truncate(value, 56)}`
}

function candidate(
  category: DerivedMemoryCategory,
  clause: string,
  value: string,
  confidenceScale: number = 1,
  descriptor?: SemanticConceptDescriptor
): MemorySemanticCandidate {
  return {
    category,
    title: titleFor(category, value),
    content: compact(clause),
    confidenceScale,
    descriptor,
  }
}

function interactionPreference(value: string): boolean {
  return /(回复|回答|输出|结论|细节|格式|风格|证据|说明|称呼|语言|简洁|详细|优先|先|不要|必须|response|answer|output|format|style|evidence|concise|detail)/iu.test(value)
}

function extractChineseCandidate(clause: string): MemorySemanticCandidate | null {
  let match = clause.match(/^(?:我|用户)(?:的)?(?:长期)?偏好(?:是|为|：|:)?\s*(.+)$/u)
  if (match?.[1]) return candidate('preference', clause, match[1])

  match = clause.match(/^(?:我|用户)(?:一直|通常|更)?(?:偏爱|更喜欢|喜欢|不喜欢|不希望)\s*(.+)$/u)
  if (match?.[1]) return candidate('preference', clause, match[1], 0.96)

  match = clause.match(/^(?:我|用户)(?:希望|要求|需要)\s*(.+)$/u)
  if (match?.[1]) return interactionPreference(match[1])
      ? candidate('preference', clause, match[1], 0.94)
      : candidate('goal', clause, match[1], 0.9)

  match = clause.match(/^(?:(?:我的|用户的)(?:长期)?|长期)?目标(?:是|为|：|:)?\s*(.+)$/u)
  if (match?.[1]) return candidate('goal', clause, match[1])

  match = clause.match(/^(?:我|用户)(?:计划|打算|想要|准备|正在努力)\s*(.+)$/u)
  if (match?.[1]) return candidate('goal', clause, match[1], 0.94)

  match = clause.match(/^(?:我|用户)(?:目前|现在)?正在(?:做|处理|推进|构建|开发|学习|研究)\s*(.+)$/u)
  if (match?.[1]) return candidate('task', clause, match[1], 0.96)

  match = clause.match(/^(?:当前|现在)(?:的)?(?:项目|工作)(?:是|为|：|:)?\s*(.+)$/u)
  if (match?.[1]) return candidate('project', clause, match[1], 0.94)

  match = clause.match(/^(?:我|用户)对\s*(.+?)\s*(?:感兴趣|有兴趣)$/u)
  if (match?.[1]) return candidate('interest', clause, match[1], 0.96)

  match = clause.match(/^(?:我|用户)(?:通常|习惯于?|一贯)\s*(.+)$/u)
  if (match?.[1]) return candidate('procedure', clause, match[1], 0.9)

  match = clause.match(/^(?:我是|用户是|我目前是|用户目前是|我的职业是|用户的职业是|我的身份是|用户的身份是)\s*(.+)$/u)
  if (match?.[1]) return candidate('fact', clause, match[1], 0.96, {
      type: 'user',
      name: '用户画像',
      stableDiscriminator: 'user:profile',
    })
  return null
}

function extractEnglishCandidate(clause: string): MemorySemanticCandidate | null {
  let match = clause.match(/^(?:I prefer|My (?:long-term )?preference is|The user prefers)\s+(.+)$/iu)
  if (match?.[1]) return candidate('preference', clause, match[1])

  match = clause.match(/^(?:I want to|I plan to|My (?:long-term )?goal is|The user's goal is)\s+(.+)$/iu)
  if (match?.[1]) return candidate('goal', clause, match[1], 0.96)

  match = clause.match(/^(?:I am|I'm)\s+(?:working on|building|developing|researching)\s+(.+)$/iu)
  if (match?.[1]) return candidate('task', clause, match[1], 0.96)

  match = clause.match(/^(?:I am|I'm|The user is)\s+interested in\s+(.+)$/iu)
  if (match?.[1]) return candidate('interest', clause, match[1], 0.96)

  match = clause.match(/^(?:I usually|The user usually)\s+(.+)$/iu)
  if (match?.[1]) return candidate('procedure', clause, match[1], 0.9)

  match = clause.match(/^(?:I am|I'm|The user is|My role is|The user's role is)\s+(?:an?\s+)?(.+)$/iu)
  if (match?.[1]) return candidate('fact', clause, match[1], 0.92, {
      type: 'user',
      name: '用户画像',
      stableDiscriminator: 'user:profile',
    })
  return null
}

/**
 * 无模型时也可工作的高置信语义提炼层。
 *
 * 只从用户明确自述中派生 Claim；原始 conversation Claim 始终保留。网页、工具输出和
 * assistant 文本不会进入画像/偏好营养层。后续模型提炼可以在同一 Candidate 边界追加，
 * 但不能绕过 Evidence provenance。
 */
export function extractDeterministicSemanticCandidates(
  evidence: MemoryEvidenceRecord
): MemorySemanticCandidate[] {
  if (evidence.category !== 'conversation' || evidence.trustLevel !== 'user_stated') return []

  const candidates = semanticClauses(evidence.content)
    .map((clause) => extractChineseCandidate(clause) ?? extractEnglishCandidate(clause))
    .filter(isPresent)
  const unique = new Map<string, MemorySemanticCandidate>()
  for (const item of candidates) {
    const key = `${item.category}:${compact(item.content).toLocaleLowerCase()}`
    if (!unique.has(key)) unique.set(key, item)
    if (unique.size >= MaxSemanticCandidates) break
  }
  return [...unique.values()]
}
