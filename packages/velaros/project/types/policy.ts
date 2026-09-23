/** 内核的静态限制：读、搜、事务规模的上限，版本号怎么算，要不要先用 ripgrep。只管正确性与守内存，不管谁能读写什么。 */
export interface CorePolicy {
  /** 要求调用方证明自己基于最新已知 revision 编辑。 */
  requireBaseRevision: boolean
  requireUniqueTarget: boolean
  maxFileSizeToReadBytes: number
  maxSearchFileSizeBytes: number
  /**
   * 版本号与内容指纹的计算方式（进程级固定，构造后不可中途切换，否则两套版本号互不可比）：
   * - "metadata"（可选，轻量快速）：版本号仅取「路径＋纳秒级修改时间＋字节数」，快照不再为计算哈希而整文件读取或扫描；
   *   代价是「字节数相同且修改时间相同」的外部改动可能被静默漏检（详见升级文档）。
   * - "content"（默认，内容指纹）：读取全文做内容哈希，能识别任意内容变化，但每次快照都要读取并哈希。
   */
  revisionStrategy: 'metadata' | 'content'
  /** 为 true 且设置了 `ProjectProviders.command` 时，adapter 扫描前优先尝试 ripgrep（失败会回退）。 */
  enableRipgrepSearch: boolean
  /** 通过 command provider 执行 ripgrep 子进程的超时时间。 */
  ripgrepTimeoutMs: number
  maxChangedFilesPerTransaction: number
  maxChangedLinesPerFile: number
  maxChangedLinesPerTransaction: number
  maxConcurrentBatchTasks: number
}
