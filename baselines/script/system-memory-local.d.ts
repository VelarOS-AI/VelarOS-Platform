declare module 'velaros:system-memory-local' {
  /**
   * 当前任务的工作记忆：用户输入、脚本、执行结果、笔记与交付物都按原文归档，list 查目录、read 按引用读原文（读取不续租、不重跑脚本）。
   * update 维护自己的笔记（key + baseRevision），plan 维护任务计划；retain、release 调整笔记与执行结果是否自动展示。笔记与计划是你的解释，不能覆盖真实回执。
   * 改动只能在 execute 里做。
   */

  /** 按种类与标题分页查当前任务的材料：只有引用、位置、大小与笔记版本。
   */
  export function list(input: MemoryQuery): Promise<MemoryPage>

  /** 按引用分页读原文：输入、源码、结果、笔记与材料都用它。
   */
  export function read(input: MemoryReadInput): Promise<MemoryContent>

  /** 改自己的一份笔记，交回它的新版本。
   */
  export function update(input: WorkspaceUpdate): Promise<WorkspaceEntry>

  /** 改自己的任务计划：只给要改的字段，其余保留，交回整份计划。
   */
  export function plan(input: Partial<TaskCapsule>): Promise<TaskCapsule>

  /** 保留一份笔记或执行结果的自动展示；不重跑脚本。
   */
  export function retain(input: MemoryRetainInput): Promise<MemoryRetention>

  /** 释放一份笔记或执行结果的自动展示，原文仍可召回。
   */
  export function release(input: MemoryReleaseInput): Promise<MemoryRetention>

  /**
   * 查当前任务的材料目录：kind 按种类筛（notes 笔记、inputs 用户输入、programs 脚本、results 执行结果、history 回复与结果、artifacts 交付物），默认全部；
   * query 按标题关键词筛；after 是上一页的 nextAfter，through 固定目录快照的结束序号；limit 每页最多 64 项。
   */
  interface MemoryQuery {
    readonly kind?: 'all' | 'notes' | 'inputs' | 'programs' | 'results' | 'history' | 'artifacts'
    readonly query?: string
    readonly after?: number
    readonly through?: number
    readonly limit?: number
  }

  /**
   * 材料目录的一页；nextAfter 不是 null 就把它当 after 接着翻。
   */
  interface MemoryPage {
    readonly items: readonly MemoryListItem[]
    readonly nextAfter: number | null
  }

  /** 按引用读一页原文：ref 是目录里的引用（或它的 id），offset、limit 按 UTF-16 字符算，一页最多 60000 个字符。读取不续租、不重跑脚本。
   * 补读执行结果中的字段时传展示给出的 pointer（JSON Pointer，以 / 开头，最多 4096 个字符）；字符串返回原文，其他值返回 JSON，offset 与 limit 针对选中字段。省略 pointer 时读整份归档。
   */
  interface MemoryReadInput {
    readonly ref: string | ContextRef
    readonly pointer?: string
    readonly offset?: number
    readonly limit?: number
  }

  /** 读到的一页原文；有 pointer 时 text、offset、totalChars 属于选中字段，record 仍标识完整归档。字符串字段不带 JSON 引号，其他字段为 JSON。 */
  interface MemoryContent extends ContextContent {
    readonly pointer?: string
  }

  /**
   * 改一份工作笔记：key 1 到 96 个字符，只用字母、数字与 _ . -，以字母或数字开头；baseRevision 是刚读到的 revision，新笔记为 0，而且必须给 body。
   * title 最多 200 个字符，body 最多 60000 个字符，sources 是它依据的原文引用（最多 64 条）；resident 为假时这份笔记不再自动展示，原文仍可召回。
   */
  interface WorkspaceUpdate {
    readonly key: string
    readonly baseRevision: number
    readonly title?: string
    readonly body?: string
    readonly sources?: readonly ContextRef[]
    readonly resident?: boolean
  }

  /**
   * 一份笔记的当前版本：ref 是这一版正文的引用，chars 是正文字符数，resident 表示它是否自动展示。
   */
  interface WorkspaceEntry {
    readonly key: string
    readonly revision: number
    readonly title: string
    readonly ref: ContextRef
    readonly resident: boolean
    readonly chars: number
  }

  /**
   * 自己维护的任务计划：nextObjective 是下一步目标（最多 2000 个字符）；hypotheses 假设、decisions 已做的决定、openQuestions 待解的问题，各最多 16 条、每条最多 1000 个字符。
   * 计划是你自己的解释，不能代替真实回执。
   */
  interface TaskCapsule {
    readonly nextObjective: string
    readonly hypotheses: readonly string[]
    readonly decisions: readonly string[]
    readonly openQuestions: readonly string[]
  }

  /** 保留一份笔记或执行结果的自动展示：结果按 turns 续租（不给是 task），笔记一直驻留到主动 release。 */
  interface MemoryRetainInput {
    readonly ref: string | ContextRef
    readonly turns?: ScriptRetention
  }

  /** 调整驻留的结果：笔记交回它的当前版本，执行结果交回租约。 */
  type MemoryRetention = WorkspaceEntry | ResultRetained | ResultReleased

  /** 释放一份笔记或执行结果的自动展示；原文仍然可以 read。 */
  interface MemoryReleaseInput {
    readonly ref: string | ContextRef
  }

  /** 目录里的一份材料：原文元数据；是笔记时还带着 key、revision（改它时作为 baseRevision 交回）与 resident。 */
  interface MemoryListItem extends ContextRecord {
    readonly key?: string
    readonly revision?: number
    readonly resident?: boolean
  }

  /**
   * 原文引用：sessionId 与 id 一起定位一份不可变原文；只能在授权给你的会话范围里读。
   */
  interface ContextRef {
    readonly sessionId: string
    readonly id: string
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
   * 执行结果的自动展示期限：成功业务回合数（1 到 32）；'segment' 保留到该结果随历史封段，'task' 保留到任务结束。主动释放仍立即生效，正文展示受上下文容量约束。
   */
  type ScriptRetention = number | 'segment' | 'task'

  /** 执行结果续租了：remainingTurns 是还会自动展示多少个成功回合，segment 表示到该结果随历史封段，task 表示到任务结束；executed 为假，脚本没有重跑。 */
  interface ResultRetained {
    readonly ref: string
    readonly remainingTurns: ScriptRetention
    readonly executed: false
  }

  /** 执行结果不再自动展示；executed 为假，脚本没有重跑。 */
  interface ResultReleased {
    readonly ref: string
    readonly released: true
    readonly executed: false
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
   * 原文的来源：user 用户输入、assistant 模型回复、tool 能力回执、event 运行事件、note 笔记、checkpoint 检查点、audit 审计记录。
   */
  type ContextRecordKind =
    'user' | 'assistant' | 'tool' | 'event' | 'note' | 'checkpoint' | 'audit'
}
