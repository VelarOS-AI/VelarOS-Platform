/**
 * 包内可调参数：超时、预算、上限、保留条数、阈值。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 * 对外承诺的上限（写进工具说明和 schema 的）在 contract/constants.ts；规则本身的数据跟着规则写在各自的 utils 文件里；类里固定用的写成类的 private static readonly。
 */

/** 项目包的可调参数，按用途分组。 */
export const ProjectTuning = Object.freeze({
  /** project:read。 */
  read: Object.freeze({
    /** 没给 maxChars 时一次调用所有文件共用的字符预算。 */
    defaultMaxChars: 24_000,
  }),
  /** project:search。 */
  search: Object.freeze({
    /** 命中合成的源码窗口总共最多多少字符（按呈现给模型的 JSON 算，含路径、版本、引用这些固定元数据）；装不下的命中只留定位。 */
    windowBudgetChars: 12_000,
  }),
  /** project:list。 */
  list: Object.freeze({
    /** 一次最多扫描多少个条目；超过就提示收窄 path 或 include。 */
    maxEntries: 100_000,
  }),
  /** 事务：编辑失败的回读建议、校验失败回执、保留原字节的差异计算、校验结果复用。 */
  transactions: Object.freeze({
    /** 编辑在 prepare 失败时，回执里建议模型回读出错文件用的 project:read maxChars（字符）。 */
    recoveryReadMaxChars: 12_000,
    /** 知道出错行时，建议回读的范围从出错行往上多读几行。 */
    recoveryReadLinesBefore: 3,
    /** 知道出错行时，建议回读的范围从出错行往下多读几行。 */
    recoveryReadLinesAfter: 6,
    /** 校验失败回执最多带几条诊断；前几条足以指路，其余只报总数。 */
    reportedDiagnostics: 10,
    /** 回执里每条诊断的 message 最多多少字符；命令型 validator 会把整段 stdout/stderr 塞进一条诊断，超出截断。 */
    diagnosticMessageChars: 2_000,
    /** 失败消息里那行摘要（第一条诊断的第一行）最多多少字符。 */
    headlineChars: 200,
    /** GB18030 文件保留原字节时，字符级差异最多找多长的编辑距离；超过就退回按前后缀对齐。 */
    byteDiffMaxEditLength: 4_096,
    /** 同上，字符级差异最多算多少毫秒；超时同样退回按前后缀对齐。 */
    byteDiffTimeoutMs: 50,
    /** 每个带 cacheKey 的 validator 最多缓存多少份通过的结果；超过从最早的删起。 */
    validationCacheEntries: 128,
    /** 一份校验结果序列化成 JSON 超过多少字符就不缓存。 */
    validationCacheResultChars: 256_000,
  }),
  /** 持久化：内存审计日志的保留条数；事务状态文件读回与写入时的各项防护上限，超过任何一项就按状态文件损坏拒绝。 */
  persistence: Object.freeze({
    /** 内存审计日志最多留多少条事件；超过从最早的丢起，避免长会话无界增长。 */
    auditEvents: 5_000,
    /** 事务状态文件最大字节数，读回和写入都按它拦。 */
    stateFileBytes: 256 * 1024 * 1024,
    /** 状态文件里最多多少个事务、投影或字节计划；不能小于内核保留的事务总数，否则内核写不进自己的状态。 */
    stateTransactions: 1_000,
    /** 一个事务最多多少个补丁（投影里的意图数、恢复计划里一个路径的归属状态数同样按它限）。 */
    statePatchesPerTransaction: 10_000,
    /** 一个事务最多多少个改动文件（基准快照、版本记录、恢复计划的条数同样按它限）；不能小于策略允许的单事务改动文件数。 */
    stateChangedFilesPerTransaction: 10_000,
    /** 正文、差量、原因这类大字段最多多少字节（UTF-8）；原字节的 base64 按它换算上限。 */
    stateContentBytes: 16 * 1024 * 1024,
    /** 事务号、补丁号、策略号、revision 这类标识最多多少字节（UTF-8）。 */
    stateIdentifierBytes: 512,
    /** 一条路径最多多少字节（UTF-8）。 */
    statePathBytes: 16 * 1024,
  }),
})
