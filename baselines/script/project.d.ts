/**
 * 用 Node 读、找和转换文件。项目改动用一次 commit；路径相对同一个项目根，projectRoot 可请求宿主授权的其他根。
 * 唯一片段直接提交；全文使用已读基线和新内容。检查此次写入先看回执，需要更多差量用 inspect；撤回用 undo。
 * 外层程序失败时先 inspect 查询持久状态。snapshot 供固定的只读观察计划使用。
 */
declare module 'velaros:project' {
  /** 以一次事务提交 changes。唯一片段无需预读；全文使用同一次读取的 before，after 给 JS 计算的新文本。回执返回紧凑差量，重试同一 requestId 可查原结果。
   */
  export function commit(input: ProjectCommitInput): Promise<ProjectCommitResult>

  /** 捕获声明式 files 纯快照计划：最多 20 个文件、每次捕获 500000 个字符；在同一项目读门内前后完整读取，任何缺失、截断或前后变化都失败。快照只证明此次捕获值相同，不能证明读取期间没有 ABA，也不授予后续写入或跳过 IO。
   */
  export function snapshot(input: ProjectSnapshotInput): Promise<ProjectSnapshotCapture>

  /** 看一次改动的差量与状态。
   */
  export function inspect(input: ProjectInspectInput): Promise<ProjectChangeInspection>

  /** 整次撤销一次改动：写回原文、删掉它新建的文件。
   */
  export function undo(input: ProjectChangeInput): Promise<ProjectUndoResult>

  /** 一个项目内一次提交 1–1000 项。正常调用自动取得请求身份；跨程序重试可复用同一个 requestId（最多 256 字符）。 */
  interface ProjectCommitInput {
    projectRoot?: string
    requestId?: string
    changes: ProjectCommitChange[]
  }

  /** 事务实际改动与紧凑差量。diffTruncated 时用 inspect 展开。 */
  interface ProjectCommitResult {
    changeRef: string
    requestId: string
    status: string
    changed: boolean
    changedFiles: string[]
    diff: string
    diffTruncated: boolean
    oldRevisions?: Record<string, string>
    newRevisions?: Record<string, string>
  }

  /**
   * 当前项目的固定纯快照计划：files 最多 20 项，key 互不相同；每次捕获正文合计最多 500000 字符。
   * 每个业务轮仍真实读盘，前后两次捕获一致才完整；同值只允许省掉纯派生和程序运行，不证明期间没有变化。
   */
  interface ProjectSnapshotInput {
    /** 可选目标项目绝对根；须经宿主授权，省略使用当前项目。引用和撤回须指定签发时的同一根。 */
    projectRoot?: string

    readonly files: readonly ProjectSnapshotEntry[]
  }

  /**
   * 领域的真实完整捕获回执。fingerprint 比较此次捕获的值，不是完整变更代次；providerId 绑定当前内核生命周期。
   * readRequests 是实际文件读取请求数，materialBytes 是捕获正文的 UTF-8 字节数，均包括前后核对；它们不代表底层磁盘的额外内部读取。
   */
  interface ProjectSnapshotCapture {
    readonly providerId: string
    readonly root: string
    readonly fingerprint: string
    readonly complete: true
    readonly checkedAt: string
    readonly readRequests: number
    readonly materialBytes: number
    readonly value: { readonly files: readonly ProjectSnapshotFile[] }
  }

  /** 查指定事务或本会话在该根最近的提交；path 只展开指定文件的差量。 */
  interface ProjectInspectInput extends ProjectChangeInput {
    path?: string
    /** 从上次 nextOffset 继续读取同一份事务差量。 */
    offset?: number
  }

  /** 一次改动的完整差量。status 是 applied（已提交）或 rolled_back（已撤销）等。 */
  interface ProjectChangeInspection {
    changeRef: string
    /** 同一会话同一项目的上一笔留存事务。 */
    previousChangeRef?: string
    requestId?: string
    status: string
    changedFiles: string[]
    oldRevisions?: Record<string, string>
    newRevisions?: Record<string, string>
    diff: string
    nextOffset?: number
    diffLines: number
  }

  /** 撤回需给同一会话同一项目的 changeRef 或 requestId。 */
  interface ProjectChangeInput {
    /** 可选目标项目绝对根；须经宿主授权，省略使用当前项目。引用和撤回须指定签发时的同一根。 */
    projectRoot?: string

    changeRef?: string
    requestId?: string
  }

  /**
   * 撤销的结果：changedFiles 是这次撤销动过的文件（写回原文的，以及删掉的那次改动新建的）。
   * 已经撤销过的再撤一次也成功（alreadyUndone 为真）。那之后文件又被改过时整个拒绝（CONFLICT_WITH_EXTERNAL_EDIT），一个文件都不动。
   */
  interface ProjectUndoResult {
    /** 撤销已完成后的附带诊断。 */
    notes?: string[]
    changeRef: string
    changedFiles: string[]
    alreadyUndone?: boolean
  }

  /** 片段按唯一原文定位。全文基线可用 UTF-8 原文或原始字节摘要；Node 客户端也接受 readFile 返回的 Buffer。新建和删除显式给 null。移动保留源属性，目标必须不存在。 */
  type ProjectCommitChange =
    | { path: string; oldText: string; newText: string }
    | {
        path: string
        before: string | ProjectCommitBytes | { sha256: string } | null
        after: string | ProjectCommitBytes | { base64: string } | null
      }
    | { from: string; to: string; before: string | ProjectCommitBytes | { sha256: string } }

  /**
   * 一个纯快照输出：path 在当前项目内，range 是要捕获的连续行；key 最多 96 字符，purpose 最多 1000 字符。
   * format 默认 text；json 严格解析正文，pointer 是最多 1024 字符的 JSON Pointer。所有转换只依赖此次捕获的正文。
   * view 默认 auto；full 请求完整展示，reference 只给引用。required 只用于本阶段确实必需的事实。
   */
  interface ProjectSnapshotEntry {
    readonly path: string
    readonly range?: ProjectLineRange
    readonly key: string
    readonly purpose: string
    readonly format?: 'text' | 'json'
    readonly pointer?: string
    readonly view?: 'auto' | 'full' | 'reference'
    readonly required?: boolean
  }

  /** 一份实际读取的连续正文；没有可用作编辑凭据的 fileRef。 */
  interface ProjectSnapshotFile {
    readonly path: string
    readonly revision: string
    readonly text: string
    readonly startLine: number
    readonly totalLines?: number
  }

  /** Node 客户端接受原始 Uint8Array（包括 Buffer），按视图范围传输。 */
  interface ProjectCommitBytes {
    readonly byteOffset: number
    readonly byteLength: number
  }

  /** 行号或连续闭区间：`51`、`[51]`、`[42, 45]`，末行不小于首行。 */
  type ProjectLineRange = number | [number] | [number, number]
}
