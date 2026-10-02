/** 状态与变更流的存储边界。 */
export const StoreLimits = Object.freeze({
  /** 单对象 JSON 字节上限。 */
  valueBytes: 262144,
  /** 对象键字符上限。 */
  keyChars: 256,
  /** 宿主范围字符上限。 */
  scopeChars: 1024,
  /** 订阅选择项上限。 */
  watchItems: 64,
  /** 默认分页条数。 */
  page: 32,
  /** 分页条数上限。 */
  maxPage: 64,
  /** 消息 JSON 字节上限。 */
  messageBytes: 16384,
  /** 每空间保留事件条数。 */
  retainedEvents: 4096,
  /** 每次扫描事件条数。 */
  scanEvents: 256,
  /** 跨连接轮询间隔毫秒。 */
  pollMs: 250,
  /** 每次目录查询上限。 */
  stores: 128,
  /** 空间名称字符上限。 */
  nameChars: 128,
  /** 空间说明字符上限。 */
  descriptionChars: 512,
})
/** 有限默认值，适配器仍需限制单次 I/O。 */
export const DefaultContextViewLimits = Object.freeze({
  /** 每步观察需求上限。 */
  intents: 16,
  /** 候选证据数量上限。 */
  candidates: 32,
  /** 每次物化的来源检索上限。 */
  searchCalls: 6,
  /** 物化时单次来源读取的字节上限。 */
  inspectBytes: 65536,
  /** 物化证据的字符上限。 */
  evidenceChars: 24000,
  /** 发布冲突后的刷新次数上限。 */
  refreshes: 2,
  /** 任务模型调用总数上限。 */
  modelCalls: 128,
  /** 任务模型 token 总数上限。 */
  modelTokens: 500000,
  /** 任务每小时的模型 token 上限（滚动一小时）；缺省不限。 */
  modelTokensPerHour: Number.MAX_SAFE_INTEGER,
  /** 单次物化时限毫秒。 */
  materializationMs: 30000,
  /** 任务租约时长毫秒。 */
  leaseMs: 360000,
})
/** 上下文公共边界上限。 */
export const ContextLimits = Object.freeze({
  /** 索引目录单页条目上限。 */
  recordPage: 256,
  /** 未发布对象至少保留一小时，供候选提交与故障诊断。 */
  orphanGraceMs: 3600000,
  /** 每小时模型用量的滚动窗口，按两个整小时的桶近似。 */
  hourlyWindowMs: 3600000,
  /** 已整理输入保留可召回的有界原文锚点，避免超大输入使维护永远无效。 */
  inputAnchorChars: 1000,
  /** 单次原文读取上限。 */
  readChars: 60000,
  /** 单页结果上限。 */
  searchItems: 100,
  /** 单条检索预览上限。 */
  previewChars: 500,
  /** 原始正文的单对象上限。 */
  objectChars: 8000000,
  /** 模型一次选入的材料上限。 */
  workingSetItems: 2000,
})
/** 观察需求能要求的表示形式。 */
export const ContextViewForms = Object.freeze([
  'full',
  'excerpt',
  'definition',
  'metadata',
  'diff',
] as const)
/** 观察需求对外约定的上限。 */
export const ViewIntentLimits = Object.freeze({
  /** 用途说明最多多少字符。 */
  purposeChars: 2000,
  /** 语义需求的目标最多多少字符。 */
  objectiveChars: 2000,
  /** 一个需求最多要几种表示形式。 */
  forms: 5,
  /** 期望正文量提示的上限（token）。 */
  maxTokensHint: 100000,
  /** 语义需求最多带几个锚点。 */
  anchors: 8,
})
/** 任务计划对外约定的上限。 */
export const TaskCapsuleLimits = Object.freeze({
  /** 下一步目标最多多少字符。 */
  objectiveChars: 2000,
  /** 假设、决定、待解问题各最多多少条。 */
  items: 16,
  /** 每一条最多多少字符。 */
  itemChars: 1000,
})
/** 领域核查报告的有界归档与展示，不扩大原始事实存储额度。 */
export const ContextVerificationLimits = Object.freeze({
  /** 范围说明与产物身份的字符上限。 */
  scopeChars: 2000,
  /** 单项名称或产物版本的字符上限。 */
  labelChars: 1000,
  /** 一个报告的检查项上限。 */
  checks: 32,
  /** 每个检查项的证据引用上限。 */
  evidenceRefs: 8,
  /** 整份报告的 JSON 字符上限。 */
  reportChars: 24000,
  /** 单项核查覆盖的精确产物数量上限。 */
  artifacts: 32,
  /** 核查或探测一次返回的费用依据上限。 */
  charges: 64,
  /** 一次宿主原子版本探测的最长等待。 */
  probeMs: 2000,
  /** 当前 helper 生命周期内保留的完整通过证明上限。 */
  cachedChecks: 128,
})
