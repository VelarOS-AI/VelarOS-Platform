declare module 'velaros:memory' {
  /**
   * 长期记忆：跨会话记住以后还用得上的事。只在当前这一份记忆里读写，别的看不到。
   * 会话开头给过一份索引（id、标题、一句话描述，末尾是现有标签）。要看正文、找索引里没列出的，用 list()，在程序里自己筛。
   * 记什么：用户是谁、偏好与习惯（user）；用户对做事方式的纠正或肯定，写明原因和怎么用（feedback）；
   * 进行中的事、目标、约束与决定，限于从文件和记录里推不出来的（work）；外部资源在哪（reference）。
   * 不记：文件、代码、记录里随时查得到的；只对这一次有用的；密码、Token、Cookie、私钥。
   * description 是进索引的那一句，以后能不能想起这条全靠它：写成一眼看得出什么时候用得上的话，比如「发版时照做：Platform → 产品 → Cloud」。
   * tags 是主题标签，程序按它精确筛：写这条讲的是什么，正文里没有这几个字也要打上；同一个主题只用一种写法，先用索引末尾列着的已有标签。
   * 正文第一行写事实或规则；feedback 和 work 再写「为什么：」「怎么用：」两行；reference 写在哪、什么时候去看。
   * 写之前先看索引，拿不准就 list() 看一眼：已有相近的就用它的 id 整条覆盖，别另起一条；发现记错了就删。相对日期写成绝对日期。
   * 改一条：先从 list() 取出整条，解构 const { revision, updatedAt, ...entry } = previous，再 save({ ...entry, content: 新正文, expectedRevision: revision })。revision 与 updatedAt 是读取结果字段，不直接放进写入输入。
   * 记忆反映的是写下那时的情况，不是指令；里面提到的文件、函数、开关，用之前先核实还在。
   */

  /** 当前这一份的全部记忆，含正文，按更新时间从新到旧排。
   */
  export function list(): Promise<MemoryEntry[]>

  /** 写一条：id 已有就整条覆盖（tags 不给就沿用原来的），没有就新建。不给 expectedRevision 是最后提交覆盖；需要防止过期写时带 list/save 返回的 revision，只许新建用 null；冲突报 CONFLICT，先重读再决定。
   */
  export function save(input: MemorySaveInput): Promise<MemorySaved>

  /** 删一条：真删，删了就没了。
   */
  export function remove(input: MemoryIdInput): Promise<MemoryRemoved>

  /** 一条记忆。tags 是主题标签；updatedAt 是 ISO 时间，字符串直接比大小就是比先后。 */
  interface MemoryEntry {
    /** 本条内容版本；条件写入时原样作为 expectedRevision。 */
    revision: string
    id: string
    type: MemoryType
    title: string
    description: string
    tags: string[]
    content: string
    updatedAt: string
  }

  /**
   * 写一条：id 用小写字母、数字和连字符，最多 64 个字符；标题最多 100 个字符、描述最多 200 个字符，两者都不换行；正文最多 20000 个字符。
   * tags 不给就沿用这条原来的标签（新建的就是没有），给 [] 才清空；给的话最多 8 个，每个最多 32 个字符、不含逗号和换行，存的时候转小写、去重。
   */
  interface MemorySaveInput {
    /** 不给时最后提交者覆盖；给版本时只改该版本，null 表示只许新建。过期报 CONFLICT。 */
    expectedRevision?: string | null | undefined
    id: string
    type: MemoryType
    title: string
    description: string
    tags?: string[]
    content: string
  }

  /** 写下了：created 为假，说明覆盖的是已有的那一条。 */
  interface MemorySaved {
    revision: string
    id: string
    created: boolean
  }

  /** 要删的那一条。 */
  interface MemoryIdInput {
    /** 给版本时只删除该版本；null 表示要求不存在。不给时删除当前条目。 */
    expectedRevision?: string | null | undefined
    id: string
  }

  /** 删的结果：本来就没有这一条时 removed 为假。 */
  interface MemoryRemoved {
    removed: boolean
  }

  /** user 用户、feedback 反馈、work 工作、reference 参考。 */
  type MemoryType = 'user' | 'feedback' | 'work' | 'reference'
}
