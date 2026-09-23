import type { ModelToolDelivery } from '@velaros-ai/agent'
import type {
  ContextContent,
  ContextReadStamp,
  ContextRef,
  ContextResourceTarget,
  ContextSourceRead,
  ContextViewForm,
} from '@velaros-ai/context'

/** @AgentView 一个搜索档位的资源上限：模型调用次数与 token、各阶段时限（毫秒）、来源查询次数、候选数、读取次数与字节数。 */
export interface SearchProfile {
  readonly modelCalls: number
  readonly modelTokens: number
  readonly finalizationTokens: number
  readonly timeoutMs: number
  readonly callTimeoutMs: number
  readonly finalizationMs: number
  readonly publicationMs?: number
  readonly outputTokens: number
  readonly projectionChars: number
  readonly sourceQueries: number
  readonly candidates: number
  readonly reads: number
  readonly readBytes: number
  readonly noProgressRounds?: number
}

/**
 * @AgentView
 * 发起或继续一项搜索。新搜索给 query（最多 16000 个字符）；续查给 resume（上一份报告的 ref），可以再带 query 追问。
 * profile 取 profiles() 里的 name，不给用默认档位（续查沿用原来的）；sources 限定来源（最多 64 个），不给就是全部可用来源；
 * context 是给搜索模型的背景说明（最多 24000 个字符）；anchors 是已知相关的资源（最多 32 个）。
 */
export interface SearchRequest {
  readonly query?: string
  readonly resume?: ContextRef
  readonly profile?: string
  readonly sources?: readonly string[]
  readonly context?: string
  readonly anchors?: readonly ContextResourceTarget[]
}

/** @AgentView 一条读过的证据：ref 是完整原文的引用，excerpt 是摘录，stamp 是读到的版本，complete 为假说明只读了一部分。 */
export interface SearchEvidence {
  readonly id: string
  readonly target: ContextResourceTarget
  readonly ref: ContextRef
  readonly excerpt: string
  readonly stamp: ContextReadStamp
  readonly complete: boolean
}

/**
 * @AgentView
 * 搜索的结论：每条发现至少引用一个 read 登记过的证据 id（候选 id 不算）；gaps 写没查清的缺口（code 用大写短词，detail 写清楚缺什么），没有就给 []；nextSteps 是建议的下一步。
 * 有缺口也可以交付已经证实的发现。整份不超过 24000 个字符。
 */
export interface SearchDraft {
  readonly findings: ReadonlyArray<{
    readonly text: string
    readonly evidenceIds: readonly string[]
  }>
  readonly gaps: ReadonlyArray<{
    readonly code: string
    readonly detail: string
  }>
  readonly nextSteps: readonly string[]
}

/**
 * @AgentView
 * 搜索报告：ref 是报告与检查点的引用，续查时交给 resume；continuation 为 closed 时不能再续。
 * status 为 partial 说明撞到了上限（stopReason、coverage.limitsHit 说明哪一项），usage 是实际用掉的资源。
 */
export interface SearchResult extends SearchDraft {
  /** Runtime 发布的统一交付及显式续查入口。 */
  readonly delivery?: ModelToolDelivery
  readonly ref: ContextRef
  readonly searchId: string
  readonly profile: string
  readonly continuation: 'available' | 'closed'
  readonly status: 'completed' | 'partial' | 'failed'
  readonly stopReason: string
  readonly evidence: readonly SearchEvidence[]
  readonly coverage: {
    readonly sources: readonly string[]
    readonly queries: readonly string[]
    readonly limitsHit: readonly string[]
  }
  readonly usage: {
    readonly modelCalls: number
    readonly sourceQueries: number
    readonly reads: number
    readonly readBytes: number
    readonly elapsedMs: number
    readonly tokens: Nullable<{
      readonly input: number
      readonly output: number
    }>
  }
}

/** 同一对象存储中的搜索状态，引用跨重启可恢复。 */
export interface SearchState {
  readonly id: string
  readonly parentSessionId: string
  readonly sessionId: string
  readonly query: string
  readonly profile: string
  readonly sources: readonly string[]
  readonly evidence: readonly SearchEvidence[]
  readonly candidates: readonly EvidenceCandidate[]
  readonly queries: readonly string[]
  readonly report?: ContextRef
  readonly activation?: string
  readonly expiresAt?: number
}

/**
 * @AgentView
 * 读一份搜索报告：mode 为 snapshot（默认）时按 UTF-16 字符分页读报告原文，给了 evidenceId 就读那条证据的原文，limit 最多 60000 个字符；
 * mode 为 current 时重新读报告里选中的证据目标、看它们现在的内容，按证据条目分页（limit 最多 16 条），不调用模型。
 */
export interface SearchReadInput {
  readonly ref: ContextRef
  readonly mode?: 'snapshot' | 'current'
  readonly evidenceId?: string
  readonly offset?: number
  readonly limit?: number
}

/**
 * @AgentView
 * 读报告的结果：snapshot 是一页原文（读证据时带着它当时的版本 stamp）；current 是这一页证据的现状，ok 为假的那项 status 说明为什么没有正文（比如按行选的内容已经变了）。
 */
export type SearchReadResult =
  | (ContextContent & { readonly mode: 'snapshot'; readonly stamp?: ContextReadStamp })
  | {
      /** 当前读取不调用模型。 */
      readonly mode: 'current'
      /** 已发布报告身份。 */
      readonly ref: ContextRef
      /** 本页刷新结果，ok 区分事实正文与失败。 */
      readonly items: ReadonlyArray<
        | (ContextSourceRead & {
            readonly id: string
            readonly target: ContextResourceTarget
            readonly ok: true
            readonly status: 'current'
          })
        | { readonly id: string; readonly ok: false; readonly status: string }
      >
      /** 可刷新的证据总数。 */
      readonly total: number
      /** 本操作不创建模型请求。 */
      readonly modelCalled: false
    }

/** @AgentView 一个搜索档位：name 传给 search 的 profile，default 为真的是不给 profile 时用的那个，limits 是它的全部资源上限。 */
export interface SearchProfileInfo {
  readonly name: string
  readonly default: boolean
  readonly limits: SearchProfile
}

/** @AgentView 在一个已授权来源里按字面检索：query 用短关键词（1 到 8000 个字符），limit 每次最多 100 个候选，默认 16。 */
export interface EvidenceQueryInput {
  readonly source: string
  readonly query: string
  readonly limit?: number
}

/** @AgentView 一个检索候选：id 在这次搜索里唯一，target 直接交给 read；preview 只帮你挑，不是已读的正文，forms 是它能读成的形式。 */
export interface EvidenceCandidate {
  readonly id: string
  readonly target: ContextResourceTarget
  readonly preview: string
  readonly forms: readonly ContextViewForm[]
}

/** @AgentView 检索结果：candidates 是本次的候选（还没读，不是证据），empty 为真说明什么也没找到。 */
export interface EvidenceCandidates {
  readonly candidates: readonly EvidenceCandidate[]
  readonly empty: boolean
  readonly source: string
  readonly query: string
}

/** @AgentView 交付已被受理：之后声明完成；宿主据此发布报告。 */
export interface SearchReportReceipt {
  readonly accepted: true
}

/** @AgentView 读一个资源并登记成证据：target 用候选里的真实 target，maxBytes 最多 60000，默认 8000。 */
export interface EvidenceReadInput {
  readonly target: ContextResourceTarget
  readonly maxBytes?: number
}
