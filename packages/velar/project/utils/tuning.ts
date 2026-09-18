/**
 * 包内可调参数：超时、预算、上限、保留条数、阈值。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 * 对外承诺的上限（写进工具说明和 schema 的）在 contract/constants.ts；规则本身的数据跟着规则写在各自的 utils 文件里；类里固定用的写成类的 private static readonly。
 */

/** 项目包的可调参数，按用途分组。 */
export const ProjectTuning = Object.freeze({
  /** 文件能力的适配层（utils/agent）：要整份正文时的读取预算，编辑版本过期时的恢复说明。 */
  agent: Object.freeze({
    /** 要整份正文时（签发可编辑视图、编辑恢复找新位置、编码转换）向内核读取的字符预算；读不全就不签发编辑引用、不给恢复候选、拒绝转换。 */
    fullReadChars: 16_000_000,
    /** 编辑版本过期时，恢复说明里候选位置与确认窗口行数的上限，超过就不给候选。 */
    recoveryItems: 10,
    /** 恢复说明里确认窗口的行最多多少字符；装不下就只给候选行号，让模型先 read。 */
    recoveryWindowChars: 10_000,
  }),
  /** 文件引用（utils/agent/file-refs.ts）：源码快照、fileRef、改动回执按会话存在进程内存里，这是它们的上限。 */
  refs: Object.freeze({
    /** 最多同时留几个会话的引用，超了丢掉最久没用的那个会话的全部引用。 */
    sessions: 32,
    /** 每个会话最多几条记录（源码快照、视图、回执各算一条），超了从最久没用的删起。 */
    recordsPerSession: 2_000,
    /** 每个会话的记录最多占多少字符（源码快照带完整正文），超了从最久没用的删起。 */
    charsPerSession: 64_000_000,
  }),
  /** edit 回执里改过的文件的窗口（utils/agent/change-windows.ts）。 */
  receiptWindows: Object.freeze({
    /** 每段改动前后各多带几行。 */
    changeContextLines: 5,
  }),
  /** 代码查询（utils/agent/code-query.ts）：`velar:code` 找目标符号的候选数。 */
  codeQuery: Object.freeze({
    /** 按符号名到代码图谱找节点时最多取几个候选；符号搜索回退到代码图谱时也不超过它。 */
    graphCandidates: 50,
  }),
  /** 模型给的正则（utils/regex-guard.ts）：文本搜索与编辑定位都在带时限的沙箱里执行，灾难回溯不再卡住整个进程。 */
  regex: Object.freeze({
    /** 一次正则扫描（整份文件）最多跑多少毫秒；超时按 INVALID_INPUT 拒绝并让模型改写更具体的 query。 */
    executionTimeoutMs: 1_000,
  }),
  /** 事务：回执带多长的差量、编辑失败的回读建议、校验失败回执、校验结果复用。 */
  transactions: Object.freeze({
    /** 编辑在 prepare 失败时，建议回读出错文件用的 read maxChars（字符）。 */
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
    /** 每个带 cacheKey 的 validator 最多缓存多少份通过的结果；超过从最早的删起。 */
    validationCacheEntries: 128,
    /** 一份校验结果序列化成 JSON 超过多少字符就不缓存。 */
    validationCacheResultChars: 256_000,
  }),
  /** 持久化：内存审计日志的保留条数；事务状态文件读回与写入时的各项防护上限，超过任何一项就按状态文件损坏拒绝。 */
  persistence: Object.freeze({
    /** 内存审计日志最多留多少条事件；超过从最早的丢起，避免长会话无界增长。 */
    auditEvents: 5_000,
    /**
     * 可撤销历史（内存里的事务加它的变更投影、字节计划）一共最多占多少字节，内存与事务状态文件共用这一个预算：
     * 超了从最旧的事务淘汰，单个事务自己就超预算时它不进可撤销历史（应用照常成功，撤销时如实说没有撤销记录）。
     * 必须留够余量给正在写盘的那一个事务（它的恢复计划也在状态文件里），两倍单事务上限加它要小于 stateFileBytes。
     */
    historyBytes: 48 * 1024 * 1024,
    /** 变更记录里每个编辑意图带的正文字段（content、expectedContent、text 这些）最多留多少字符，超出截断并标注；记录是审计面，不是正文副本。 */
    changeIntentContentChars: 4_000,
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
  /** 内核：内存里保留多少事务（LocalProjectKernel），宿主没给命令提供者时本地子进程怎么跑（NodeCommandProvider）。 */
  kernel: Object.freeze({
    /** 内存里最多留多少个事务（含准备好还没应用的），超过从最早的淘汰，落盘的变更投影跟着同一上限；正常的准备→应用不会淘汰到刚写的事务。persistence.stateTransactions 不能比它小。 */
    retainedTransactions: 1_000,
    /** 已结束（已应用、已回滚）的事务最多留多少个；回滚要用它们记下的原文，所以只按最久没用的淘汰。 */
    retainedTerminalTransactions: 200,
    /** 本地子进程命令没给 timeoutMs 时的超时，毫秒。 */
    commandTimeoutMs: 30_000,
    /** 本地子进程命令的 stdout、stderr 各最多收多少字符（execa 的 maxBuffer），到了就按输出截断返回。 */
    commandOutputChars: 8 * 1024 * 1024,
  }),
  /** 文件访问：FileStore、ProjectGitIndex，以及列目录、读文件的工具函数。 */
  files: Object.freeze({
    /** 流式读文件算内容哈希、顺带认编码时每块读多少字节；解码正文的分块在公共件 @velaros-ai/text-files。 */
    readChunkBytes: 64 * 1024,
    /** 版本按 metadata 算时，判断是不是二进制只看文件开头多少字节。 */
    binarySampleBytes: 8_000,
    /** stat 给的建议读取窗口最多多少行。 */
    statRecommendedLines: 120,
    /** stat 只给不超过这么多字节的文本文件数行数，更大的只报大小。 */
    statLineCountBytes: 1024 * 1024,
    /** 搜索前的文件格式分类（能不能交给 ripgrep 直接搜）最多缓存多少个文件。 */
    searchTextKindEntries: 4_096,
    /** 格式分类缓存里超过这么久没被查到的条目会被清掉，毫秒；两次清理之间也至少隔这么久。 */
    searchTextKindIdleMs: 60_000,
    /** 列目录没给 maxFiles 时最多列多少条。 */
    listMaxFiles: 5_000,
    /** 列目录要递归却没给 maxDepth 时往下几层（第 1 层是起点这一层）。 */
    listDepth: 3,
    /** observe 扫描工作区没给 maxDepth 时往下走几层。 */
    observeDepth: 20,
    /** 文件层跑的 git 子命令（check-ignore、add --intent-to-add、rm --cached、diff --cached）的超时，毫秒。 */
    gitTimeoutMs: 10_000,
    /** 探测项目根在不在 git 工作区里（git rev-parse）的超时，毫秒。 */
    gitProbeTimeoutMs: 5_000,
  }),
  /** 内核的查询面：搜索、目标解析、证据包（ProjectQueries）。搜索命中的总数由调用方的 maxResults 管，一个文件的命中不另设上限。 */
  queries: Object.freeze({
    /** 内核搜索没给 maxResults 时最多返回几处命中。 */
    searchResults: 50,
    /** 解析出的目标最多留多少个，超过从最早的淘汰。 */
    retainedTargets: 500,
    /** 证据包最多留多少个，超过从最早的淘汰。 */
    retainedEvidence: 500,
    /** 证据包的新鲜窗口没给前后行数时，目标前后各带几行。 */
    evidenceWindowLines: 5,
    /** 证据包的新鲜窗口最多读多少字节。 */
    evidenceWindowBytes: 80_000,
    /** 证据包给「往前 / 往后接着读」的建议时，至少建议读几行。 */
    evidenceSuggestedReadLines: 20,
    /** 交给模型的命中片段最多多少字符；脱敏之后才截，截断不会把密钥切成脱敏正则认不出的半截。 */
    snippetChars: 400,
    /** 脱敏前先取多宽的窗口：命中所在的整行，行比它还长时以命中为中心向两侧各取一半。 */
    snippetWindowChars: 4_000,
  }),
  /** ripgrep 搜索（utils/files/ripgrep.ts）。 */
  ripgrep: Object.freeze({
    /** 一次搜索最多返回几处命中，调用方给得再多也按它截；截到了就标 truncated。要不小于 `velar:project` 的 search 上限加一。 */
    maxResults: 10_000,
    /** 每处命中的片段最多多少字符（也是传给 rg 的 --max-columns）。 */
    snippetChars: 400,
    /** rg 用几个线程。 */
    threads: 4,
  }),
  /** 编辑定位失败时回给模型的线索（utils/editing 与 JS/TS 补丁策略）：候选几个、摘录多长、模糊定位的门槛；全都有上限，不把整个文件塞回上下文。 */
  editing: Object.freeze({
    /** edit 的 match 零命中或多处命中时最多回几个候选；多处命中时也只收集这么多处精确匹配。 */
    candidates: 8,
    /** 每个候选最多带多少字符原文；更长的截断，也不再替它找能唯一定位的上下文。 */
    candidateChars: 1_200,
    /** 为让候选的 match 在可见区域里唯一，往两侧最多各扩多少字符上下文。 */
    candidateContextChars: 120,
    /** match 零命中时在可见区域里找相近原文最多扫多少字符；match 本身比这还长就不找。 */
    similarScanChars: 16_000,
    /** 按 symbol 定位遇到同名符号时，错误信息里列出几个候选。 */
    symbolCandidates: 8,
    /** oldText 零命中时最多比较多少个候选起点。 */
    candidateStarts: 200,
    /** 没有任何一行能对齐时，取最长的几条 oldText 行按片段相似度找候选。 */
    fuzzyAnchors: 8,
    /** 参与片段相似度的 oldText 行至少多少字符；更短的行太常见，不拿来找候选。 */
    fuzzyAnchorMinChars: 4,
    /** 片段相似度（0–1）至少多少才算候选。 */
    fuzzySimilarity: 0.75,
    /** 多处匹配时列出前几处的行号，其余只报总数。 */
    reportedMatches: 10,
    /** 首个分歧行的摘录最多多少字符；超长行以分歧处为中心截窗。 */
    mismatchExcerptChars: 160,
    /** 找匹配所属的外层行时最多往上看几行。 */
    enclosingLookbackLines: 200,
    /** 外层行的摘录最多多少字符。 */
    enclosingLineChars: 100,
  }),
  /** 文件适配器（impl/adapters）：搜索没给 maxResults 时单个文件最多返回几处命中。 */
  adapters: Object.freeze({
    /** 纯文本 adapter 的文本搜索。 */
    textHits: 20,
    /** 通用代码 adapter（Python、Go、Rust 等按正则认符号）的符号搜索。 */
    codeSymbolHits: 20,
    /** JS/TS adapter 的 AST 符号搜索。 */
    jsTsSymbolHits: 50,
  }),
  /** JS/TS 语言层（utils/jsts-ast.ts）：adapter、补丁策略与语法校验器共用的 AST 解析缓存和语法诊断。 */
  jsTs: Object.freeze({
    /** 解析结果按（路径、内容哈希）最多缓存多少份；超过从最久没用的淘汰。 */
    cachedParses: 200,
    /** 语法诊断里出错行的摘录最多多少字符；超长行以出错列为中心截窗。 */
    syntaxExcerptChars: 160,
    /** 一个文件的前几条语法诊断附带出错行前后几行的源码预览。 */
    syntaxPreviewDiagnostics: 10,
  }),
})
