/**
 * 父会话快照的原文与整理补丁：先 list 看元数据，挑与整理目标相关的近期记录和当前笔记，再按引用 read 少量原文，最后用 submit 交来补丁。
 * 只能读这次整理授权的快照；读取额度用完后不能再读，直接交付已有结论。
 */
declare module 'velaros:context-materials' {
  /** 列快照里的原文元数据，不读正文。
   */
  export function list(input: ContextMaterialsQuery): Promise<ContextMaintenancePage>

  /** 按快照里的引用读一页父会话原文，正文在 text。
   */
  export function read(input: ContextMaterialsReadInput): Promise<ContextContent>

  /** 交来整理补丁：先整份校验，不合格就报错（修正后再交），合格就受理；受理之后声明完成。
   */
  export function submit(input: ContextPatch): Promise<ContextPatchReceipt>

  /** 翻快照目录：after 是上一页的 nextAfter，从头翻不给；limit 每页最多 64 项。 */
  interface ContextMaterialsQuery {
    readonly after?: number
    readonly limit?: number
  }

  /**
   * 快照目录的一页：只有元数据，正文按 ref 用 read 读；nextAfter 不是 null 就把它当 after 接着翻。
   */
  interface ContextMaintenancePage {
    readonly items: readonly ContextRecord[]
    readonly nextAfter: number | null
  }

  /** 按快照里的引用读一页父会话原文：offset、limit 按 UTF-16 字符算，一页最多 32000 个字符，还受本次整理剩下的读取额度限制。 */
  interface ContextMaterialsReadInput {
    readonly ref: ContextRef
    readonly offset?: number
    readonly limit?: number
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
   * 整理补丁：只改父会话的展示，不改原文。最小的有效补丁只有 baseRevision（照抄 snapshot.baseRevision）、summary（有证据支持的整理说明，1 到 3000 个字符）与 unresolved（未解决事项，最多 32 条、每条最多 1000 个字符）；
   * 其余字段只在确实需要、而且已经查明时才给，不要为了填满而改所有分区。notes、inputs、releaseResults、releaseStoreRefs 各最多 64 项，整份不超过 60000 个字符。
   * 所有引用都用父快照里的真实引用，不能用本整理会话的输出引用；遵循 snapshot.intent 的 focus 与 preserve。
   */
  interface ContextPatch {
    readonly baseRevision: string
    readonly summary: string
    readonly unresolved: readonly string[]
    /** 逐项更新当前约束/未解事项；只改变模型解释，原始最新用户输入始终优先。 */
    readonly active?: ActiveContextPatch
    /** 笔记的派生展示；主模型的笔记、计划与结论归主模型维护，这里只改展示。 */
    readonly notes?: readonly ContextNotePresentation[]
    /** 输入摘要：只有完整原文已经进入本支线请求才可替换；只看到引用、片段或元数据时省略，并在 unresolved 里报告缺口。 */
    readonly inputs?: readonly ContextInputSummary[]
    /** 最近一卷（snapshot.volume）的叙事；快照里没有卷、或还没读清楚那一段时省略。 */
    readonly volume?: VolumeNarrative
    /** 退出自动展示的空间引用，只能选 snapshot.storeRefs 里的；不删除对象、不取消订阅、不撤回权限。 */
    readonly releaseStoreRefs?: readonly string[]
    /** 退出自动展示的执行结果引用；明确要求保留、或还有未决操作依赖的不能释放。 */
    readonly releaseResults?: readonly string[]
    /**
     * 观察的展示调整：sourceRef 照抄 snapshot.observationRef；按 snapshot.observation.manifest 里的静态 key 改 view，Runtime 写回观察源码并对已采集的结果重新展示，不重跑脚本。
     * summaries 的 key、resultRef、contentHash 必须与 snapshot.observation.blocks 对上，text 1 到 12000 个字符；view 用 summary 模式时必须有对得上的摘要。不能改采集表达式、key、purpose、priority 或权限。
     */
    readonly observation?: ScriptOutputEdit & {
      readonly sourceRef: string
      readonly summaries?: ReadonlyArray<{
        readonly key: string
        readonly resultRef: string
        readonly contentHash: string
        readonly text: string
      }>
    }
  }

  /** 补丁通过了校验、已被受理：之后声明完成，宿主在父会话的下一次请求前重新核验版本再发布。 */
  interface ContextPatchReceipt {
    readonly accepted: true
    readonly baseRevision: string
  }

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
   * 原文引用：sessionId 与 id 一起定位一份不可变原文；只能在授权给你的会话范围里读。
   */
  interface ContextRef {
    readonly sessionId: string
    readonly id: string
  }

  /**
   * 当前状态核对：baseRevision 照抄 snapshot.active.revision；reviewedInput 必须是 snapshot.goals 的最新原始输入，而且全文已进入本整理会话。
   * changes 最多 64 项，逐条按现有 id 操作；约束只允许用比其原始输入更晚的用户输入作为撤销/取代依据，不能用模型笔记撤销用户约束。
   * superseded 需要 replacement（1 到 1000 字符）；retracted 仅用于约束；resolved 仅用于未解事项。每项 evidence 至少一段、最多 8 段真实引文。
   * 这是带来源的模型解释，不是原始用户授权；引文存在也不保证解释正确。仍成立的项不提交变更，未解项省略时继续保留。
   * additions 用于明确核对后的补充或重开；与 changes 合计最多 64 项。text 为 1 到 1000 字符，每项 evidence 为 1 到 8 段；约束证据必须是全文已读的用户原文。
   */
  interface ActiveContextPatch {
    readonly baseRevision: number
    readonly reviewedInput: ContextRef
    readonly additions?: ReadonlyArray<{
      readonly kind: 'constraint' | 'question'
      readonly text: string
      readonly evidence: readonly ActiveContextEvidence[]
    }>
    readonly changes: ReadonlyArray<{
      readonly id: string
      readonly status: 'superseded' | 'retracted' | 'resolved'
      readonly replacement?: string
      readonly evidence: readonly ActiveContextEvidence[]
    }>
  }

  /**
   * 一份笔记的派生展示：ref 必须是这份笔记当前版本的引用；summary（1 到 12000 个字符）与 resident 至少给一个；明确要求保留的笔记不能移出自动展示。
   */
  interface ContextNotePresentation {
    /** 精确不可变笔记引用；主模型更新后自动失效。 */
    readonly ref: ContextRef
    /** 可选派生摘要，保持解释来源。 */
    readonly summary?: string
    /** false 只退出自动展示，原文仍可召回。 */
    readonly resident?: boolean
  }

  /**
   * 一份用户输入的理解摘要：ref 是输入原文，baseRevision 取 snapshot.inputRevisions 里对应条目的 revision；summary 必须保留用户的实际任务、顺序、验收条件与约束，
   * constraints 逐条列出约束（已有摘要时先读它，逐字保留原有约束再追加），unresolved 是没解决的事项。
   */
  interface ContextInputSummary {
    readonly ref: ContextRef
    readonly summary: string
    readonly constraints: readonly string[]
    readonly unresolved: readonly string[]
    readonly baseRevision: number
  }

  /**
   * 最新一卷（snapshot.volume）的叙事：summary 写这一段做了什么、查明了什么（1 到 3000 个字符）；evidence 是它直接依据的原文引用；
   * unresolved 是到这一卷为止仍没解决的全部事项（snapshot.ledgers.unresolved 里还没解决的照抄保留）；negativeAttempts 是这一段里试过但没成功的做法，以后别再重复（已在 snapshot.ledgers.negativeAttempts 里的不用重写）。
   */
  interface VolumeNarrative {
    readonly summary: string
    readonly evidence: readonly ContextRef[]
    readonly unresolved: readonly string[]
    readonly negativeAttempts: readonly string[]
  }

  /**
   * 展示的调整：config 替换整份输出的展示预算，outputs 按稳定 key 整个替换那一块的 view；其余观察意图保持不变。
   */
  interface ScriptOutputEdit {
    /** 替换整体展示配置；不填表示保持原样。 */
    readonly config?: ScriptOutputConfig
    /** 按稳定键完整替换 view，其余观察意图保持不变。 */
    readonly outputs?: ReadonlyArray<{ readonly key: string; readonly view: ScriptOutputView }>
  }

  /**
   * 原文的来源：user 用户输入、assistant 模型回复、tool 能力回执、event 运行事件、note 笔记、checkpoint 检查点、audit 审计记录。
   */
  type ContextRecordKind =
    'user' | 'assistant' | 'tool' | 'event' | 'note' | 'checkpoint' | 'audit'

  /** 一段直接证据：ref 指原文；offset 为 UTF-16 起点；quote 为该位置逐字引文，最多 4000 字符。 */
  interface ActiveContextEvidence {
    readonly ref: ContextRef
    readonly offset: number
    readonly quote: string
  }

  /**
   * 整份输出的展示预算：maxChars 包括输出目录与省略说明（最多 200000），实际分配由宿主决定；交的放不下时每块只露出一部分，
   * 显式配置优先于各块 view.maxChars 的申请，0 表示不展示；未配置且没有块申请时使用默认预算。结果头里写着这次实际给的 displayChars。要看的内容多（几个大文件、长文），就分几次执行各交一部分。
   */
  interface ScriptOutputConfig {
    readonly maxChars?: number
  }

  /**
   * 怎么展示（只影响你下一轮看到多少；原值在采集上限内完整保存，可以按引用召回）：
   * mode 默认 auto，按展示预算挑内容；full 要求整个值放得下，放不下就只给引用；reference 只给引用；summary 只展示整理服务已生成、版本匹配的摘要，没有就给引用。
   * maxChars 本块最多展示多少字符（最多 200000）；未 configure 整体预算时，显式正数也申请本块所需的有限展示份额，实际仍受宿主总预算限制，不保证全文。reference/summary 不扩大整体申请；lines 是一基闭区间 [起, 止]；maxItems 列表最多展示几项；edge 从头部或尾部选片段；paths 是 JSON Pointer 数组（最多 64 个），只展示这些字段。
   */
  interface ScriptOutputView {
    readonly mode?: 'auto' | 'full' | 'reference' | 'summary'
    readonly maxChars?: number
    readonly lines?: readonly [number, number]
    readonly maxItems?: number
    readonly edge?: 'head' | 'tail'
    readonly paths?: readonly string[]
  }
}
