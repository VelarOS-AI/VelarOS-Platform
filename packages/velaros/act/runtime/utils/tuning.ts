/** Runtime 的缺省调节参数；宿主显式配置仍优先。 */
export const ActRuntimeTuning = Object.freeze({
  /** 宿主笔记正文每页字符上限。 */
  noteReadChars: 32000,
  /** 一次模型工具交付最多附带的已保存脚本数。 */
  deliveryScripts: 16,
  /** 专项工具在 runtime 分区中保留的事实目录上限。 */
  modelToolContextChars: 16000,
  /** 同一观察代码连续失败后暂停自动重跑的次数。 */
  observationFailures: 3,
  /** 请求与追踪材料默认字符上限。 */
  frameChars: 1000000,
  /** 原始归档单页读取字符上限。 */
  readChars: 60000,
  /** 工作笔记默认分页条目数。 */
  workspacePage: 32,
  /** 每个会话最多缓存的不可变结果分类数；只含正文身份与观察标记。 */
  historyClassificationEntries: 4096,
  /** 协议增量替换条目上限。 */
  edits: 128,
  /** 协议修复默认次数。 */
  protocolRepairs: 2,
  /** 限速错误没带等待时长时，等这么久再预留。 */
  rateRetryMs: 60_000,
  /** 段内一条新历史第一次交付的字符上限；之后同段逐字复用。 */
  segmentEntryChars: 24_000,
  /** 一卷规则骨架的字符上限，超出保留首尾。 */
  volumeSkeletonChars: 6_000,
  /** 骨架里每条说明文字的字符上限。 */
  volumeLineChars: 160,
  /** 一卷最多记下多少个改过的笔记键。 */
  volumeNotes: 16,
  /** 目录里同一级的卷超过这么多就合并最老的一批。 */
  volumeIndex: 24,
  /** 一次合并多少卷。 */
  volumeMerge: 12,
  /** 底座每张长期单最多列几条。 */
  ledgerItems: 16,
  /** 长期单每条最多显示的字符数；原文按出处召回。 */
  ledgerItemChars: 400,
  /** 长期单超出条数时最多保留几个出处引用。 */
  ledgerSources: 8,
  /** 底座最多列几条段起点之前的任务目标。 */
  foldedGoals: 16,
  /** 自动封的一卷至少这么多轮、期间又没改笔记和计划，就让整理支线补写叙事。 */
  narrateTurns: 6,
  /** 一段里某个分区缺页达到这么多次，封段时按它调整笔记份额。 */
  shareFaults: 2,
  /** 笔记份额每次调整的幅度。 */
  shareStep: 0.05,
  /** 本帧尾最多列几条最近的缺页。 */
  recentFaults: 4,
})
