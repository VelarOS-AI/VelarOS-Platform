/**
 * 只在搜索会话里可用：在本轮授权的来源里按字面检索候选，再读真实资源、登记成不可变的证据，最后用 report 交付结论；都只能在 execute 里调用，检索与读取各自计入这次搜索的预算。
 * 收尾阶段不能再检索或读取，直接用已有证据 report。
 */
declare module 'velaros:evidence' {
  /** 在一个来源里按字面检索候选；source 用本轮实际授权的来源。
   */
  export function query(input: EvidenceQueryInput): Promise<EvidenceCandidates>

  /** 读一个资源并登记成证据：返回证据 id、原文引用与读到的版本。
   */
  export function read(input: EvidenceReadInput): Promise<SearchEvidence>

  /** 交付这次搜索的结论；受理之后声明完成。结论不合约定时报错，修正后再交。
   */
  export function report(input: SearchDraft): Promise<SearchReportReceipt>

  /** 在一个已授权来源里按字面检索：query 用短关键词（1 到 8000 个字符），limit 每次最多 100 个候选，默认 16。 */
  interface EvidenceQueryInput {
    readonly source: string
    readonly query: string
    readonly limit?: number
  }

  /** 检索结果：candidates 是本次的候选（还没读，不是证据），empty 为真说明什么也没找到。 */
  interface EvidenceCandidates {
    readonly candidates: readonly EvidenceCandidate[]
    readonly empty: boolean
    readonly source: string
    readonly query: string
  }

  /** 读一个资源并登记成证据：target 用候选里的真实 target，maxBytes 最多 60000，默认 8000。 */
  interface EvidenceReadInput {
    readonly target: ContextResourceTarget
    readonly maxBytes?: number
  }

  /** 一条读过的证据：ref 是完整原文的引用，excerpt 是摘录，stamp 是读到的版本，complete 为假说明只读了一部分。 */
  interface SearchEvidence {
    readonly id: string
    readonly target: ContextResourceTarget
    readonly ref: ContextRef
    readonly excerpt: string
    readonly stamp: ContextReadStamp
    readonly complete: boolean
  }

  /**
   * 搜索的结论：每条发现至少引用一个 read 登记过的证据 id（候选 id 不算）；gaps 写没查清的缺口（code 用大写短词，detail 写清楚缺什么），没有就给 []；nextSteps 是建议的下一步。
   * 有缺口也可以交付已经证实的发现。整份不超过 24000 个字符。
   */
  interface SearchDraft {
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

  /** 交付已被受理：之后声明完成；宿主据此发布报告。 */
  interface SearchReportReceipt {
    readonly accepted: true
  }

  /** 一个检索候选：id 在这次搜索里唯一，target 直接交给 read；preview 只帮你挑，不是已读的正文，forms 是它能读成的形式。 */
  interface EvidenceCandidate {
    readonly id: string
    readonly target: ContextResourceTarget
    readonly preview: string
    readonly forms: readonly ContextViewForm[]
  }

  /**
   * 来源里的一个资源：sourceId 是来源，resourceId 是来源里的资源身份，selector 选读哪一部分，不给就是整份。
   */
  interface ContextResourceTarget {
    readonly kind: 'resource'
    readonly sourceId: string
    readonly resourceId: string
    readonly selector?: ContextSelector
  }

  /**
   * 原文引用：sessionId 与 id 一起定位一份不可变原文；只能在授权给你的会话范围里读。
   */
  interface ContextRef {
    readonly sessionId: string
    /** 新记录签发 8 位十六进制引用，按会话精确查找；历史身份继续按原值读取。 */
    readonly id: string
  }

  /**
   * 读到的是哪个版本：revision 是来源给的版本（没有就是 null），contentHash 是正文指纹，observedAt 是读取时间；
   * consistency 说明能不能核对：snapshot 快照、revision-checkable 可按版本核对、observed-only 只知道读的时候是这样。
   */
  interface ContextReadStamp {
    readonly sourceId: string
    readonly resourceId: string
    readonly revision: string | null
    readonly contentHash: string
    readonly observedAt: string
    readonly consistency: 'snapshot' | 'revision-checkable' | 'observed-only'
  }

  /**
   * 能读成的形式：full 全文、excerpt 片段、definition 定义、metadata 元数据、diff 差异。
   */
  type ContextViewForm = 'full' | 'excerpt' | 'definition' | 'metadata' | 'diff'

  /**
   * 读资源的哪一部分：whole 整份，lines 按行（start、end 从 1 数，含两端），symbol 按名字取一个符号。
   */
  type ContextSelector =
    | { readonly kind: 'whole' }
    | { readonly kind: 'lines'; readonly start: number; readonly end: number }
    | { readonly kind: 'symbol'; readonly name: string }
}
