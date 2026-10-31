/** Runtime 的缺省调节参数；宿主显式配置仍优先。 */
export const ActRuntimeTuning = Object.freeze({
  /** 单次上下文数据响应最多受理的材料调用数。 */
  maintenanceCalls: 16,
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
  /** 单页追踪复用正文的字符上限；超限正文仍读取，但不额外保留在共享缓存。 */
  tracePageCacheChars: 4_000_000,
  /** 单页正文缓存的条目上限，空正文与缺失事实也占一个条目。 */
  tracePageCacheEntries: 4096,
  /** 追踪重建在连续计算达到此时长后归还事件循环，让执行环境准备等 IO 继续。 */
  traceReadSliceMs: 8,
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
  /** 原始输出历史前缀扣除须覆盖范围元数据的额外成本。 */
  materialDeltaSavings: 128,
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

/** 提取与复核分别有界调用；正文和响应的硬上限不随模型窗口无限增长。 */
export const CompletionReviewLimits = Object.freeze({
  /** 驱动明确标记的瞬时故障最多原样重试两次。 */
  providerRetries: 2,
  /** 单次退避上限，取消与父任务期限仍立即生效。 */
  providerRetryMaxMs: 30_000,
  /** 每次完成尝试中，格式或引文核对失败后的专项纠正次数。 */
  protocolRepairs: 1,
  /** 一次专项请求的总时限；允许推理模型完整审阅，仍受父任务剩余时限约束。 */
  timeoutMs: 120_000,
  /** 单次提取或复核的最高输出 Token。 */
  outputTokens: 4096,
  /** 完整需求保持可见，每次只裁定至多八项，避免有界响应装不下整份报告。 */
  verdictBatch: 8,
  /** 反例调查只选择少量高影响边界，仍共用既有执行次数与全部模型预算。 */
  counterexamples: 2,
  /** 裁定前补充证据的最多逻辑轮数，模型重试仍共用父任务预算。 */
  discoveryRounds: 2,
  /** 每轮补读的最多文件数，总产物上限保持不变。 */
  discoveryFiles: 8,
  /** 当前任务完整用户原文的 UTF-16 字符总上限。 */
  originalChars: 48_000,
  /** 最终答复及执行证据各自的 UTF-16 字符上限。 */
  evidenceChars: 32_000,
  /** 主任务与所属执行分支轮流考虑的完整源码、回执对数量上限。 */
  executionResults: 48,
  /** 内联完整正文及文件元数据文本的 UTF-8 字节总上限；模型窗口另由编译器核对。 */
  artifactBytes: 1_000_000,
  /** 有按需读取口时先发送小材料与目录，避免反复装入大源码全文。 */
  initialArtifactBytes: 64_000,
  /** 单份原文的宿主读取容量；查询结果另有更小的总预算。 */
  sourceBytes: 16_777_216,
  /** 按需读取最多缓存两份最大原文；之后重新读取，内存保持有界。 */
  sourceCacheBytes: 33_554_432,
  /** 执行目录按完整来源对计数，不限制为最近的固定正文窗口。 */
  executionCatalog: 512,
  /** 一次完整复核（含取证、模型重试和格式纠正）的期限。 */
  reviewTimeoutMs: 600_000,
  /** 每次取证必须批量提出，最多四轮；最后一轮只交裁定。 */
  evidenceRounds: 4,
  /** 一轮最多 16 项，整个复核最多 64 项查询。 */
  evidenceBatch: 16,
  /** 一次复核内实际受理的查询项总上限。 */
  evidenceQueries: 64,
  /** 返回正文总计最多 128 KiB，每轮最多 32 KiB。 */
  evidenceBytes: 131_072,
  /** 每批实际返回的 UTF-8 原文字节上限。 */
  evidenceBatchBytes: 32_768,
  /** 字面查找与连续读取的协议上限。 */
  evidenceReadChars: 32_000,
  /** 字面查找关键字的 UTF-16 字符上限。 */
  evidenceLiteralChars: 256,
  /** 一项字面查找最多返回的匹配数量。 */
  evidenceMatches: 16,
  /** 每个匹配前后附带的连续 UTF-16 字符数。 */
  evidenceContextChars: 160,
  /** 编译后的输入与输出以外保留的上下文余量。 */
  reserveTokens: 512,
  /** 仅在实际编译超窗时，最多按测量结果缩减八次内联读取额度。 */
  artifactAdjustments: 8,
  /** 单次专项响应文本的 UTF-16 字符上限。 */
  responseChars: 32_000,
  /** 一份固定需求清单的条目上限。 */
  requirements: 24,
  /** 所有需求引用的不同产物身份总数上限。 */
  artifacts: 32,
})

/** 独立执行验证的固定资源上限，模型不能扩大。 */
export const CompletionValidationLimits = Object.freeze({
  /** 同一次完成复核最多受理两次验证，包括参数错误。 */
  attempts: 2,
  /** 每次最多选择十六个需求和文件。 */
  artifacts: 16,
  /** 模型生成源码的 UTF-8 字节上限。 */
  codeBytes: 32_768,
  /** 两路输出合计的 UTF-8 字节上限。 */
  outputBytes: 16_384,
  /** 包括副本准备、预检和程序运行的墙钟上限。 */
  timeoutMs: 15_000,
})
