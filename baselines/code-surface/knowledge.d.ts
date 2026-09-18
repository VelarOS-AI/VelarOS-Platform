declare module 'velar:knowledge' {
  /**
   * 工作区知识库：在已经建好的索引里检索文档与代码知识（全文加语义的混合检索），需要时增量同步、看索引健康。
   * 检索是只读的：零命中而这个工作区还没建过索引时，会自动补一次增量同步再重搜，结果里的 autoSync 说明这件事。
   * 知道路径就直接读文件，不用检索；要找代码里的符号与引用用代码能力，这里找的是知识。
   */

  /**
   * 检索：query 必填。workspaceRoot 不给就是当前空间的工作区（环境报告里写着）；空间没有默认工作区时要给。
   * sourceKinds 只要这几类来源；pathHints、symbolHints 是路径与符号提示，抬高相关文件与代码的排序，各最多 20 条；
   * documentIds 把范围限定在这些文档上，最多 100 个；limit 要几条命中，默认 8，最多 50。
   */
  interface KnowledgeSearchInput {
    query: string
    workspaceRoot?: string
    sourceKinds?: KnowledgeSourceKind[]
    pathHints?: string[]
    symbolHints?: string[]
    documentIds?: string[]
    limit?: number
  }

  /**
   * 检索结果：results 按相关度排好。autoSync 只在这次零命中、自动为这个工作区补过一次增量索引并重搜过时出现——
   * 它出现而 count 仍为 0，就是这个工作区里真没有，不要再 sync 重试。
   */
  interface KnowledgeFound {
    workspaceRoot: string
    count: number
    results: KnowledgeHit[]
    indexIssues: KnowledgeIndexIssue[]
    autoSync?: { scanned: number; indexed: number }
  }

  /** 同步：两项都可以不给（写 sync({})）；workspaceRoot 同检索，force 为真就跳过短时节流、马上重扫。 */
  interface KnowledgeSyncInput {
    workspaceRoot?: string
    force?: boolean
  }

  /**
   * 同步结果：扫了多少个文件，新建或更新了多少份文档（upserted），重建了多少份的索引（reindexed，reindexBlocked 是该重建却没能重建的），
   * 删掉了多少份已经不在的，跳过了多少个没变的；forced 说这次是不是强制重扫。
   */
  interface KnowledgeWorkspaceSyncResult {
    workspaceRoot: string
    scanned: number
    upserted: number
    reindexed: number
    reindexBlocked: number
    removed: number
    skipped: number
    forced: boolean
  }

  /**
   * 索引健康：文档总数与各索引状态的数量；outdated 是内容策略变了、该重新同步的。
   * activeProfile 两项是当前嵌入模型（embedding）已经覆盖、还没覆盖的文档数——没覆盖的只能走全文检索。
   * trackedFiles 是在跟踪的文件数，vectorRows 是向量行数；workspaces 是本次运行同步过的工作区。
   */
  interface KnowledgeHealth {
    totalDocuments: number
    readyDocuments: number
    pendingDocuments: number
    partialDocuments: number
    failedDocuments: number
    outdatedDocuments: number
    activeProfileIndexedDocuments: number
    activeProfileMissingDocuments: number
    totalChunks: number
    trackedFiles: number
    vectorRows: number
    embedding: { provider: string; model: string }
    workspaces: KnowledgeWorkspaceSyncState[]
  }

  /** 知识来源类型：markdown、text（纯文本）、json、config（配置文件）、code（代码知识）。 */
  type KnowledgeSourceKind = 'markdown' | 'text' | 'json' | 'config' | 'code'

  /**
   * 一条命中：content 是整份正文，snippet 是命中处的片段，score 越大越相关。
   * matchType 说怎么命中的：vector（语义）、text（全文）、hybrid（两者都中）、recent（空查询时的最近文档）。
   * indexStatus 不是 ready 的文档只做过一部分索引；indexError 只在索引出过错时出现。updatedAt 是毫秒时间戳。
   */
  interface KnowledgeHit {
    id: string
    path: string
    title: string
    summary: string
    snippet: string
    content: string
    sourceKind: KnowledgeSourceKind
    tags: string[]
    score: number
    matchType: 'vector' | 'text' | 'hybrid' | 'recent'
    indexStatus: 'pending' | 'ready' | 'partial' | 'failed'
    indexError?: string
    updatedAt: number
  }

  /**
   * 命中里记着的一类索引问题：怎么回事（sample 是其中一条原文）、影响了哪些文档、该怎么办（guidance）。
   * actionable 为真的要用户去处理（比如修嵌入凭据），照 guidance 告诉用户。
   */
  interface KnowledgeIndexIssue {
    kind: 'embedding-auth-invalid-issuer' | 'embedding-auth' | 'index-error'
    count: number
    sample: string
    actionable: boolean
    guidance: string
    affectedDocumentIds: string[]
  }

  /** 一个工作区最近一次同步的时刻（毫秒时间戳）。 */
  interface KnowledgeWorkspaceSyncState {
    workspaceRoot: string
    lastSyncedAt: number
  }

  /** 检索知识：交回按相关度排好的命中，每条带整份正文与命中处的片段。 */
  export function search(input: KnowledgeSearchInput): Promise<KnowledgeFound>

  /** 把工作区的文档、配置与代码增量同步进索引：刚改过一批文件、想马上搜到时用。 */
  export function sync(input: KnowledgeSyncInput): Promise<KnowledgeWorkspaceSyncResult>

  /** 看索引健康：文档总数、各状态的数量、当前嵌入模型覆盖了多少、各工作区最近同步时刻。只读。 */
  export function diagnostics(): Promise<KnowledgeHealth>
}
