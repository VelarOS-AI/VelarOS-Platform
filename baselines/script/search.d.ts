/**
 * 有界高级搜索：另起一个只读的搜索模型，在已授权的来源里检索、读证据，交回发现、证据引用与缺口。
 * search 只能在 execute 里调用；read 读已发布的报告或刷新其中的证据，不调用模型，observe 里也能用。
 */
declare module 'velaros:search' {
  /** 列出能选的搜索档位、默认的那个与它们的全部资源上限。
   */
  export function profiles(): Promise<SearchProfileInfo[]>

  /** 新建或续查一项有界搜索，返回报告。
   */
  export function search(input: SearchRequest): Promise<SearchResult>

  /** 读已发布的报告：snapshot 读当时的原文，按 text/offset/totalChars 续读；current 重读选中证据的现状，按条目 offset、items.length 与 total 续读，保留每项 ok、stamp 和 complete，不把本页当全部证据。两种读取都不调用模型。
   */
  export function read(input: SearchReadInput): Promise<SearchReadResult>

  /** 一个搜索档位：name 传给 search 的 profile，default 为真的是不给 profile 时用的那个，limits 是它的全部资源上限。 */
  interface SearchProfileInfo {
    readonly name: string
    readonly default: boolean
    readonly limits: SearchProfile
  }

  /**
   * 发起或继续一项搜索。新搜索给 query（最多 16000 个字符）；续查给 resume（上一份报告的 ref），可以再带 query 追问。
   * profile 取 profiles() 里的 name，不给用默认档位（续查沿用原来的）；sources 限定来源（最多 64 个），不给就是全部可用来源；
   * context 是给搜索模型的背景说明（最多 24000 个字符）；anchors 是已知相关的资源（最多 32 个）。
   */
  interface SearchRequest {
    readonly query?: string
    readonly resume?: ContextRef
    readonly profile?: string
    readonly sources?: readonly string[]
    readonly context?: string
    readonly anchors?: readonly ContextResourceTarget[]
  }

  /**
   * 搜索报告：ref 是报告与检查点的引用，续查时交给 resume；continuation 为 closed 时不能再续。
   * status 为 partial 说明撞到了上限（stopReason、coverage.limitsHit 说明哪一项），usage 是实际用掉的资源。
   */
  interface SearchResult extends SearchDraft {
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
      readonly tokens: {
        readonly input: number
        readonly output: number
      } | null
    }
  }

  /**
   * 读一份搜索报告：mode 为 snapshot（默认）时按 UTF-16 字符分页读报告原文，给了 evidenceId 就读那条证据的原文，limit 最多 60000 个字符；
   * mode 为 current 时重新读报告里选中的证据目标、看它们现在的内容，按证据条目分页（limit 最多 16 条），不调用模型。
   */
  interface SearchReadInput {
    readonly ref: ContextRef
    readonly mode?: 'snapshot' | 'current'
    readonly evidenceId?: string
    readonly offset?: number
    readonly limit?: number
  }

  /**
   * 读报告的结果：snapshot 是一页原文（读证据时带着它当时的版本 stamp）；current 是这一页证据的现状，ok 为假的那项 status 说明为什么没有正文（比如按行选的内容已经变了）。
   */
  type SearchReadResult =
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

  /** 一个搜索档位的资源上限：模型调用次数与 token、各阶段时限（毫秒）、来源查询次数、候选数、读取次数与字节数。 */
  interface SearchProfile {
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
   * 原文引用：sessionId 与 id 一起定位一份不可变原文；只能在授权给你的会话范围里读。
   */
  interface ContextRef {
    readonly sessionId: string
    /** 新记录签发 8 位十六进制引用，按会话精确查找；历史身份继续按原值读取。 */
    readonly id: string
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

  /**
   * 交付清单：payload 是交付正文的引用，artifacts 是随附的证据、脚本与结果；status 为 completed 也只表示交付了，不等于验收通过。continuation 给出接着做的入口。
   */
  interface ModelToolDelivery {
    /** 清单自身的持久引用。 */
    readonly ref: { readonly sessionId: string; readonly id: string }
    /** 清单协议版本。 */
    readonly schemaVersion: 1
    /** 工具种类，由实际宿主配置决定。 */
    readonly kind: string
    /** 实际生产者会话。 */
    readonly sessionId: string
    /** 交付所属的父逻辑任务。 */
    readonly parentTaskId?: string
    /** 完成状态，交付不等于领域验收通过。 */
    readonly status: 'completed' | 'partial' | 'failed'
    /** 领域原始报告或补丁的引用。 */
    readonly payload: { readonly sessionId: string; readonly id: string }
    /** 发布时固定的证据与产物位置及原始对象指纹。 */
    readonly artifacts: ReadonlyArray<{
      readonly kind: 'evidence' | 'script' | 'result'
      readonly ref: { readonly sessionId: string; readonly id: string }
      readonly objectId: string
    }>
    /** 本次清单没有附带的较早脚本数量。 */
    readonly omittedScripts: number
    /** 宿主签发的继续入口；参数仍须经过原能力验证。 */
    readonly continuation?: {
      readonly operation: string
      readonly input: Readonly<Record<string, unknown>>
    }
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
   * 读到的一页原文：text 从第 offset 个字符开始（按 UTF-16 算），totalChars 是整份正文的字符数，没读完就从 offset + text.length 接着读。
   */
  interface ContextContent {
    readonly record: ContextRecord
    readonly text: string
    readonly totalChars: number
    readonly offset: number
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
   * 从来源读到的正文：complete 为假说明只读了一部分；dependencies 是这份正文依赖的其他资源版本。
   */
  interface ContextSourceRead {
    readonly dependencies?: readonly ContextReadStamp[]
    readonly text: string
    readonly stamp: ContextReadStamp
    readonly form: ContextViewForm
    readonly complete: boolean
    readonly mediaType: string
  }

  /**
   * 读资源的哪一部分：whole 整份，lines 按行（start、end 从 1 数，含两端），symbol 按名字取一个符号。
   */
  type ContextSelector =
    | { readonly kind: 'whole' }
    | { readonly kind: 'lines'; readonly start: number; readonly end: number }
    | { readonly kind: 'symbol'; readonly name: string }

  /**
   * 一份原文的元数据：sequence 是它在会话里的序号，chars 是正文字符数，sources 是它引用的原文，createdAt 是 ISO 时间；正文按 ref 另读。
   */
  interface ContextRecord {
    readonly ref: ContextRef
    readonly sequence: number
    readonly kind: ContextRecordKind
    readonly title: string
    readonly objectId: string
    readonly chars: number
    readonly sources: readonly ContextRef[]
    readonly createdAt: string
  }

  /**
   * 能读成的形式：full 全文、excerpt 片段、definition 定义、metadata 元数据、diff 差异。
   */
  type ContextViewForm = 'full' | 'excerpt' | 'definition' | 'metadata' | 'diff'

  /**
   * 原文的来源：user 用户输入、assistant 模型回复、tool 能力回执、event 运行事件、note 笔记、checkpoint 检查点、audit 审计记录。
   */
  type ContextRecordKind =
    'user' | 'assistant' | 'tool' | 'event' | 'note' | 'checkpoint' | 'audit'
}
