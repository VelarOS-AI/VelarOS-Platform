/** Runtime 的缺省调节参数；宿主显式配置仍优先。 */
export const ActRuntimeTuning = Object.freeze({
  /** 随机帧身份默认取八位十六进制；与既有身份冲突时逐位延长。 */
  frameMarkerChars: 8,
  /** 常驻能力索引的软字符配额；剩余完整目录从 modules.list 分页读取。 */
  moduleIndexChars: 4096,
  /** 每帧能力、npm 与 Skill 引子的最大字符数，其余内容从完整目录按需读取。 */
  inventoryChars: 12000,
  /** 环境索引中每条用途或读取诊断的展示上限。 */
  inventorySummaryChars: 180,
  /** 当前运行状态的目标字符上限；不可裁剪的事实超过它时明确报告。 */
  stateChars: 8192,
  /** 当前状态细节的软预算份额，必要事实仍由最终请求核对。 */
  stateShare: 0.15,
  /** 状态裁剪须覆盖引用、统计与归档的额外成本，避免小材料越裁越大。 */
  stateMinimumSavings: 1024,
  /** 变化摘要保留的前段；完整补丁按当前状态引用读取。 */
  statePatchChars: 160,
  /** 每条细节引用与裁剪标记的保守字符余量。 */
  stateRecallChars: 256,
  /** 单项核查诊断的展示上限，避免长身份或产物元数据占满全部诊断配额。 */
  verificationCheckChars: 512,
  /** 长核查名称在紧凑诊断中的前段；完整名称按报告引用召回。 */
  verificationLabelChars: 160,
  /** 宿主笔记正文每页字符上限。 */
  noteReadChars: 32000,
  /** 一次模型工具交付最多附带的已保存脚本数。 */
  deliveryScripts: 16,
  /** 专项工具在 runtime 分区中保留的事实目录上限。 */
  modelToolContextChars: 32000,
  /** 子任务派发正文内父输入摘录的总字符上限，完整原文仍由普通文件提供。 */
  parentTaskPreviewChars: 8192,
  /** 原始状态中同类成功回执的汇总起点；模型展示另按实际编码大小选择。 */
  receiptGroupCount: 9,
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
  /** 少轮多操作同样需要叙事：一卷实际执行结果达到此数时也触发。 */
  narrateResults: 6,
  /** 直接叙事仅对供应商明确标记的瞬时故障重试，活动预算与取消继续优先。 */
  narrationRetries: 2,
  /** 直接叙事沿用供应商等待时间并退避，单次等待不超过此毫秒数。 */
  narrationRetryMaxMs: 30_000,
  /** 一段里某个分区缺页达到这么多次，封段时按它调整笔记份额。 */
  shareFaults: 2,
  /** 笔记份额每次调整的幅度。 */
  shareStep: 0.05,
  /** 本帧尾最多列几条最近的缺页。 */
  recentFaults: 4,
})
