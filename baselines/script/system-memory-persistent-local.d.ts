declare module 'velaros:system-memory-persistent-local' {
  /**
   * 长期记忆：跨会话保存用户偏好、反馈、工作决定与资源位置，作用域由宿主固定。与当前任务的笔记不同，任务笔记用 update，跨会话的知识用 save。
   * 只保存以后仍然有用的；原始代码、临时结果与秘密留在它们的来源。记忆是写下那时的情况，使用前先核实。
   */

  /**
   * 当前任务的工作记忆：用户输入、脚本、执行结果、笔记与交付物都按原文归档，list 查目录、read 按引用读原文（读取不续租、不重跑脚本）。
   * update 维护自己的笔记（key + baseRevision），plan 维护任务计划；retain、release 调整笔记与执行结果是否自动展示。笔记与计划是你的解释，不能覆盖真实回执。
   * 改动只能在 execute 里做。
   */

  /** 召回长期记忆：id 精确取一条；query 按 id、标题、描述、标签与正文匹配关键词；按 offset 翻页，limit 默认 8、最多 32。 */
  interface LongTermMemoryQuery {
    readonly id?: string
    readonly query?: string
    readonly offset?: number
    readonly limit?: number
  }

  /** 召回到的长期记忆，含正文；total 是全部匹配的条数，nextOffset 不是 null 就接着翻。 */
  interface LongTermMemoryPage {
    readonly items: readonly MemoryEntry[]
    readonly total: number
    readonly nextOffset: number | null
  }

  /**
   * 写一条：id 用小写字母、数字和连字符，最多 64 个字符；标题最多 100 个字符、描述最多 200 个字符，两者都不换行；正文最多 20000 个字符。
   * tags 不给就沿用这条原来的标签（新建的就是没有），给 [] 才清空；给的话最多 8 个，每个最多 32 个字符、不含逗号和换行，存的时候转小写、去重。
   */
  interface MemorySaveInput {
    id: string
    type: MemoryType
    title: string
    description: string
    tags?: string[]
    content: string
  }

  /** 写下了：created 为假，说明覆盖的是已有的那一条。 */
  interface MemorySaved {
    id: string
    created: boolean
  }

  /** 要删的那一条。 */
  interface MemoryIdInput {
    id: string
  }

  /** 删的结果：本来就没有这一条时 removed 为假。 */
  interface MemoryRemoved {
    removed: boolean
  }

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

  /** 按引用读一页原文：ref 是目录里的引用（或它的 id），offset、limit 按 UTF-16 字符算，一页最多 60000 个字符。读取不续租、不重跑脚本。 */
  interface MemoryReadInput {
    readonly ref: string | ContextRef
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

  /** 一条记忆。tags 是主题标签；updatedAt 是 ISO 时间，字符串直接比大小就是比先后。 */
  interface MemoryEntry {
    id: string
    type: MemoryType
    title: string
    description: string
    tags: string[]
    content: string
    updatedAt: string
  }

  /** user 用户、feedback 反馈、work 工作、reference 参考。 */
  type MemoryType = 'user' | 'feedback' | 'work' | 'reference'

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
   * 执行结果的自动展示期限：成功业务回合数（1 到 32），或者 'task' 表示到任务结束。
   */
  type ScriptRetention = number | 'task'

  /** 执行结果续租了：remainingTurns 是还会自动展示多少个成功回合（task 表示到任务结束）；executed 为假，脚本没有重跑。 */
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
   * 原文的来源：user 用户输入、assistant 模型回复、tool 能力回执、event 运行事件、note 笔记、checkpoint 检查点、audit 审计记录。
   */
  type ContextRecordKind =
    'user' | 'assistant' | 'tool' | 'event' | 'note' | 'checkpoint' | 'audit'

  /** 分页召回长期记忆，含正文。
   */
  export function recall(input: LongTermMemoryQuery): Promise<LongTermMemoryPage>

  /** 写一条长期记忆：同一个 id 整条覆盖，tags 不给就沿用原来的。
   */
  export function save(input: MemorySaveInput): Promise<MemorySaved>

  /** 删掉一条长期记忆的原文；与 release 只释放当前任务的展示不同。
   */
  export function remove(input: MemoryIdInput): Promise<MemoryRemoved>

  /** 按种类与标题分页查当前任务的材料：只有引用、位置、大小与笔记版本。
   */
  export function list(input: MemoryQuery): Promise<MemoryPage>

  /** 按引用分页读原文：输入、源码、结果、笔记与材料都用它。
   */
  export function read(input: MemoryReadInput): Promise<ContextContent>

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
}
