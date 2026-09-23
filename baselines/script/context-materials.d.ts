declare module 'velaros:context-materials' {
  /**
   * 父会话快照的原文与整理补丁：先 list 看元数据，挑与整理目标相关的近期记录和当前笔记，再按引用 read 少量原文，最后用 submit 交来补丁。
   * 只能读这次整理授权的快照；读取额度用完后不能再读，直接交付已有结论。
   */

  /** 翻快照目录：after 是上一页的 nextAfter，从头翻不给；limit 每页最多 64 项。 */
  interface ContextMaterialsQuery {
   readonly after?:number
   readonly limit?:number
  }

  /**
   * 快照目录的一页：只有元数据，正文按 ref 用 read 读；nextAfter 不是 null 就把它当 after 接着翻。
   */
  interface ContextMaintenancePage {
   readonly items:readonly ContextRecord[]
   readonly nextAfter:number | null
  }

  /** 按快照里的引用读一页父会话原文：offset、limit 按 UTF-16 字符算，一页最多 32000 个字符，还受本次整理剩下的读取额度限制。 */
  interface ContextMaterialsReadInput {
   readonly ref:ContextRef
   readonly offset?:number
   readonly limit?:number
  }

  /**
   * 读到的一页原文：text 从第 offset 个字符开始（按 UTF-16 算），totalChars 是整份正文的字符数，没读完就从 offset + text.length 接着读。
   */
  interface ContextContent { readonly record: ContextRecord; readonly text: string; readonly totalChars: number; readonly offset: number }

  /**
   * 整理补丁：只改父会话的展示，不改原文。最小的有效补丁只有 baseRevision（照抄 snapshot.baseRevision）、summary（有证据支持的整理说明，1 到 3000 个字符）与 unresolved（未解决事项，最多 32 条、每条最多 1000 个字符）；
   * 其余字段只在确实需要、而且已经查明时才给，不要为了填满而改所有分区。notes、inputs、releaseResults、releaseStoreRefs 各最多 64 项，整份不超过 60000 个字符。
   * 所有引用都用父快照里的真实引用，不能用本整理会话的输出引用；遵循 snapshot.intent 的 focus 与 preserve。
   */
  interface ContextPatch {
   readonly baseRevision:string
   readonly summary:string
   readonly unresolved:readonly string[]
   /** 笔记的派生展示；主模型的笔记、计划与结论归主模型维护，这里只改展示。 */
   readonly notes?:readonly ContextNotePresentation[]
   /** 输入摘要：只有完整原文已经进入本支线请求才可替换；只看到引用、片段或元数据时省略，并在 unresolved 里报告缺口。 */
   readonly inputs?:readonly ContextInputSummary[]
   /** 较早历史的摘要区间；没有必要或确认不了边界时省略。 */
   readonly history?:HistoryCheckpoint
   /** 退出自动展示的空间引用，只能选 snapshot.storeRefs 里的；不删除对象、不取消订阅、不撤回权限。 */
   readonly releaseStoreRefs?:readonly string[]
   /** 退出自动展示的执行结果引用；明确要求保留、或还有未决操作依赖的不能释放。 */
   readonly releaseResults?:readonly string[]
   /**
    * 观察的展示调整：sourceRef 照抄 snapshot.observationRef；按 snapshot.observation.manifest 里的静态 key 改 view，Runtime 写回观察源码并对已采集的结果重新展示，不重跑脚本。
    * summaries 的 key、resultRef、contentHash 必须与 snapshot.observation.blocks 对上，text 1 到 12000 个字符；view 用 summary 模式时必须有对得上的摘要。不能改采集表达式、key、purpose、priority 或权限。
    */
   readonly observation?:ScriptOutputEdit & {readonly sourceRef:string;readonly summaries?:ReadonlyArray<{readonly key:string;readonly resultRef:string;readonly contentHash:string;readonly text:string}>}
   /** 近期记录窗口的大小：0 到 64 的整数，不是记录数组。 */
   readonly recentRecords?:number
  }

  /** 补丁通过了校验、已被受理：之后声明完成，宿主在父会话的下一次请求前重新核验版本再发布。 */
  interface ContextPatchReceipt {
   readonly accepted:true
   readonly baseRevision:string
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
  interface ContextRef { readonly sessionId: string; readonly id: string }

  /**
   * 一份笔记的派生展示：ref 必须是这份笔记当前版本的引用；summary（1 到 12000 个字符）与 resident 至少给一个；明确要求保留的笔记不能移出自动展示。
   */
  interface ContextNotePresentation {
   /** 精确不可变笔记引用；主模型更新后自动失效。 */
   readonly ref:ContextRef
   /** 可选派生摘要，保持解释来源。 */
   readonly summary?:string
   /** false 只退出自动展示，原文仍可召回。 */
   readonly resident?:boolean
  }

  /**
   * 一份用户输入的理解摘要：ref 是输入原文，baseRevision 取 snapshot.inputRevisions 里对应条目的 revision；summary 必须保留用户的实际任务、顺序、验收条件与约束，
   * constraints 逐条列出约束（已有摘要时先读它，逐字保留原有约束再追加），unresolved 是没解决的事项。
   */
  interface ContextInputSummary {
    readonly ref:ContextRef
    readonly summary:string
    readonly constraints:readonly string[]
    readonly unresolved:readonly string[]
    readonly baseRevision:number
  }

  /**
   * 较早历史的一段摘要：baseThrough 到 through 是这一段的序号范围，through 必须是已完成脚本结果的 sequence，并留下最近两个响应不收进来；
   * evidence 是它直接依据的原文引用，unresolved 是没解决的事项，negativeAttempts 是试过但没成功的做法。
   */
  interface HistoryCheckpoint {
      readonly baseThrough: number;
      readonly through: number;
      readonly summary: string;
      readonly evidence: readonly ContextRef[];
      readonly unresolved: readonly string[];
      readonly negativeAttempts: readonly string[];
  }

  /**
   * 展示的调整：config 替换整份输出的展示预算，outputs 按稳定 key 整个替换那一块的 view；其余观察意图保持不变。
   */
  interface ScriptOutputEdit {
    /** 替换整体展示配置；不填表示保持原样。 */
    readonly config?: ScriptOutputConfig
    /** 按稳定键完整替换 view，其余观察意图保持不变。 */
    readonly outputs?: ReadonlyArray<{readonly key:string; readonly view:ScriptOutputView}>
  }

  /**
   * 原文的来源：user 用户输入、assistant 模型回复、tool 能力回执、event 运行事件、note 笔记、checkpoint 检查点、audit 审计记录。
   */
  type ContextRecordKind = 'user' | 'assistant' | 'tool' | 'event' | 'note' | 'checkpoint' | 'audit'

  /**
   * 整份输出的展示预算：maxChars 包括输出目录与省略说明（最多 200000），实际分配仍由宿主决定。
   */
  interface ScriptOutputConfig {
    readonly maxChars?: number
  }

  /**
   * 怎么展示（只影响你下一轮看到多少，原值照样完整保存，可以按引用召回）：
   * mode 默认 auto，按展示预算挑内容；full 要求整个值放得下，放不下就只给引用；reference 只给引用；summary 只展示整理服务已生成、版本匹配的摘要，没有就给引用。
   * maxChars 本块最多展示多少字符（最多 200000）；lines 是一基闭区间 [起, 止]；maxItems 列表最多展示几项；edge 从头部或尾部选片段；paths 是 JSON Pointer 数组（最多 64 个），只展示这些字段。
   */
  interface ScriptOutputView {
    readonly mode?: 'auto' | 'full' | 'reference' | 'summary'
    readonly maxChars?: number
    readonly lines?: readonly [number, number]
    readonly maxItems?: number
    readonly edge?: 'head' | 'tail'
    readonly paths?: readonly string[]
  }

  /** 列快照里的原文元数据，不读正文。
   */
  export function list(input: ContextMaterialsQuery): Promise<ContextMaintenancePage>

  /** 按快照里的引用读一页父会话原文，正文在 text。
   */
  export function read(input: ContextMaterialsReadInput): Promise<ContextContent>

  /** 交来整理补丁：先整份校验，不合格就报错（修正后再交），合格就受理；受理之后声明完成。
   */
  export function submit(input: ContextPatch): Promise<ContextPatchReceipt>
}
