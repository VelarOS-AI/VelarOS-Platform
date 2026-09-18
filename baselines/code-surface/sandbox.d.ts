declare module 'velar:sandbox' {
  /**
   * 演练沙箱：把一个目录镜像出来，命令在镜像里跑、写不到外面；看过差量、用户点头之后才落回源目录。
   */

  /** 建沙箱：source 相对宿主给的根解析，不给就是那个根；network 不给时镜像里的命令连不上网；ignored 不给按 link。 */
  interface SandboxCreateInput {
    source?: string
    network?: boolean
    ignored?: SandboxIgnoredMode
  }

  /** 一个沙箱：id 就是目录名，root 是镜像根（cwd 落在它之内的命令一律受约束），source 是被镜像的真实目录。 */
  interface SandboxRecord {
    id: string
    root: string
    source: string
    createdAt: number
    network: boolean
    ignored: SandboxIgnoredMode
    fileCount: number
    bytes: number
    /** 链接到真实目录的忽略目录（相对路径）。 */
    linkedDirectories: string[]
    /** 源目录是 git 仓库：镜像里的 .git 已把推送地址改掉（嵌套仓库、子模块的也改）。 */
    git: boolean
    /** 没放进镜像的 `.git` 链接文件（相对路径）：它们指向源目录外的真实仓库（git worktree、单独镜像的子模块），放进来镜像里的 git 会直接读写那个仓库。 */
    detachedGitLinks?: string[]
  }

  /** 在镜像里跑一条命令：工作目录钉在镜像根，写到镜像外会失败；timeoutMs、maxOutputChars 不给用宿主的缺省，超过宿主上限会被钳下来。 */
  interface SandboxRunInput {
    id: string
    command: string
    timeoutMs?: number
    maxOutputChars?: number
  }

  /** 在镜像里跑完一条命令：回执加上是哪个沙箱、跑的哪条命令。 */
  interface SandboxRunResult extends SandboxCommandOutcome {
    id: string
    command: string
  }

  /** 看差量：maxFiles 限制新增与修改各列最多列多少条，删除列不受限；不给用宿主的缺省。 */
  interface SandboxDiffInput {
    id: string
    maxFiles?: number
  }

  /** 镜像相对创建时的变化：三列相对路径（删除列永远完整，truncated 说明另外两列被截），文本差量有界，omittedDiffs 是没附差量的文件数；gitChanged 表示 .git 里有东西变了。 */
  interface SandboxDiff {
    sandboxId: string
    source: string
    created: string[]
    modified: string[]
    deleted: string[]
    truncated: boolean
    gitChanged: boolean
    textDiffs: SandboxTextDiff[]
    omittedDiffs: number
    note?: string
    /** 这份差量的指纹：三列的完整路径与镜像里对应文件的印记算出来的摘要，不受 maxFiles 截断影响；落回时交回来，镜像在确认之后又变过就整批不落。 */
    fingerprint?: string
  }

  /** 把镜像里的变化落回源目录：paths 只落这些相对路径，不给就全部；落回一定先向用户确认，被拒就抛错、什么都不落。 */
  interface SandboxApplyInput {
    id: string
    paths?: string[]
  }

  /** 落回的结果：三列是真正写进源目录的相对路径；skippedGit 表示 .git 里的变化没有落（永远不落）。 */
  interface SandboxApplyResult {
    sandboxId: string
    created: string[]
    modified: string[]
    deleted: string[]
    skippedGit: boolean
  }

  /** 丢弃镜像；沙箱本来就不在也不算错。 */
  interface SandboxDiscardInput {
    id: string
  }

  /** 丢弃的结果：沙箱本来就不在时 removed 为 false。 */
  interface SandboxDiscardResult {
    sandboxId: string
    removed: boolean
  }

  /** 镜像时 gitignore 忽略的目录怎么处理：link 链接到真实目录（能读、写不进），copy 复制过来，skip 不要。忽略的文件一律不复制。 */
  type SandboxIgnoredMode = 'link' | 'copy' | 'skip'

  /** 一条命令跑完的回执：命令自己失败（非零退出、超时）也是正常回执，不抛错；exitCode 为 null 表示进程被信号打断，truncated 表示输出按上限截过。 */
  interface SandboxCommandOutcome {
    exitCode: number | null
    stdout: string
    stderr: string
    durationMs: number
    timedOut: boolean
    truncated: boolean
    success: boolean
  }

  /** 一个文本文件的统一差量；超过预算时 truncated 为真、diff 被截断。 */
  interface SandboxTextDiff {
    path: string
    diff: string
    truncated: boolean
  }

  /**
   * 把一个目录镜像到临时区，脚本先在镜像里跑：落回之前源目录一个字节都没变，镜像随便糟蹋，用完 discard。
   * 回执里的 id 是后面四个操作要的那个；镜像里的命令写不出镜像根，所以脚本里算错的路径在这里只会报错。
   * gitignore 忽略的目录缺省链接到真实目录（能读，写不进），要在镜像里重新构建就把 ignored 传成 copy。
   */
  export function create(input: SandboxCreateInput): Promise<SandboxRecord>

  /**
   * 在镜像里跑一条命令，工作目录钉在镜像根。命令自己失败（非零退出、超时）是正常回执、不抛错，照 success 判。
   * 危险命令（递归删除、丢未提交改动的 git 这类）照常先问用户，用户不点头就抛错、命令不跑。
   * 镜像里连不上网，除非建沙箱时把 network 开了。
   */
  export function run(input: SandboxRunInput): Promise<SandboxRunResult>

  /**
   * 看镜像相对建的时候变了什么：三列相对路径加有界的文本差量。删除列永远完整，另外两列被 maxFiles 截掉时 truncated 为真。
   */
  export function diff(input: SandboxDiffInput): Promise<SandboxDiff>

  /**
   * 把镜像里的变化落回源目录。落回前一定把删除与覆盖摆给用户确认，用户不点头就抛错、一个文件都不落；
   * 当前空间还可能先核一遍这次要落的路径（项目空间核对项目许不许写），核不过同样一个文件都不落。
   * 确认之后镜像又被改过，宿主整批不落。`.git` 里的变化永远不落，要那部分就在源目录重放那几条 git 命令。
   * 镜像里什么都没变时不问用户，三列都是空的。
   */
  export function apply(input: SandboxApplyInput): Promise<SandboxApplyResult>

  /**
   * 删掉镜像，源目录不受影响；沙箱本来就不在时 removed 为 false，不算错。
   */
  export function discard(input: SandboxDiscardInput): Promise<SandboxDiscardResult>
}
