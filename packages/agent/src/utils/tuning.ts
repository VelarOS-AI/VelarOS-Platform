/**
 * 包内可调参数：超时、缓冲、保留条数、缺省条数、阈值。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 *
 * 常量按四处放（ADR 0007）：
 * - 对外承诺的（工具名、错误码、协议版本、环境变量、写进工具说明和 schema 的上限）在 `contract/constants.ts`，改了等于改契约；
 * - 可调的都在这里，按域分组、每项一句说明；实现里不再散写数字缺省值，门禁核对；
 * - 某个类里固定用的文案、模式、名单写成那个类的 `private static readonly`；
 * - 规则本身的数据（厂商错误码名单、执行状态集合、可索引的消息种类）跟着规则写在各自的 utils 文件里；算法与格式里的数字（哈希取几位、单位换算）就地写。
 */

/** Agent 包的可调参数，按域分组。 */
export const AgentTuning = Object.freeze({
  /** 主会话与子 Agent 的回合循环：SoloStreamLoop、QueryLoop、StreamTurn、QueryTurn、收尾门。 */
  loop: Object.freeze({
    /** 模型窗口未知时按多少 token 估算（注入 runtimeOverride 的派发路径拿不到窗口）；编辑预算与运行档判档共用它。 */
    unknownContextWindowTokens: 128_000,
    /** 距离回合步数上限还剩几步时进入收尾：留出交代结论的余地，不让最后一步被硬截断。 */
    turnCapWindDownMargin: 2,
    /** 流式正文被上游截断后，最多重新续写几次。 */
    outputTruncationRecoveryAttempts: 2,
    /** 流在工具调用中途断开后，最多续流几次。 */
    streamContinuationRecoveryAttempts: 1,
    /** 一轮只吐了推理、没有可见正文时，最多重问几次要正文。 */
    reasoningOnlyAnswerRecoveryAttempts: 2,
    /** 子 Agent 结构化输出不合 schema 时，最多让它自纠几次。 */
    subAgentStructuredOutputRepairAttempts: 2,
    /** 同一个工具面指纹下，最多强制发起几次工具发现，防止发现-失败反复循环。 */
    forcedDiscoveryPerFingerprint: 2,
    /** 连续几轮只有工具调用、没有面向用户的话，就补一条过程说明。 */
    silentToolTurnThreshold: 2,
    /** 同一条收尾门连续挡住几次后不再挡：避免模型被一条规则卡死在原地。 */
    repeatedFinishingGateBlockLimit: 3,
    /** 稳定前缀至少有多少字符才值得给供应方下 prompt-cache 断点；太短的前缀缓存收益抵不上开销。 */
    promptCacheMinStableSystemChars: 2_000,
    /** 开了 HTML 实时预览时单条回复的最低输出预算（token）：完整 HTML/CSS/JS 要一次写完，普通档位会在闭合协议前被截断。 */
    htmlArtifactMinimumOutputTokens: 24_000,
    /** 流式空闲多久还没有新片就给用户补一条"仍在思考"的提示，毫秒。 */
    streamIdleThinkingNoticeDelayMs: 15_000,
    /** setTimeout 能接受的最大延迟毫秒数；超过它的等待要分段，否则会立刻触发。 */
    maxNativeTimerDelayMs: 2_147_483_647,
    /** 普通执行的墙钟硬上限，毫秒：产品形态是过夜马拉松任务，所以给到 24 小时。 */
    standardExecutionWallClockTimeoutMs: 24 * 60 * 60_000,
    /** 目标模式执行的墙钟硬上限，毫秒：多日任务靠它兜底，不得小于普通执行的墙钟。 */
    goalExecutionWallClockTimeoutMs: 7 * 24 * 60 * 60_000,
    /** 子 Agent 的软期限，毫秒：到点进入收尾而不是硬杀，半成品副作用比超时更贵。 */
    subAgentSoftDeadlineMs: 4 * 60 * 60_000,
    /** 模型流空闲多久判死，毫秒：这是唯一的"模型没反应"闸，调大等于挂死更久才暴露。 */
    modelStreamIdleTimeoutMs: 5 * 60_000,
    /** 同一个父会话最多保留几条已结束的子 Agent 线程供下一轮续跑。 */
    subAgentRetainedThreadsPerSession: 8,
    /** 全局最多保留多少条已结束的子 Agent 线程。 */
    subAgentRetainedThreadsTotal: 64,
    /** 保留线程空闲多久就丢弃，毫秒：从脱离执行起算，由派发与收尾时顺手清理。 */
    subAgentRetainedThreadIdleTtlMs: 30 * 60_000,
    /** 单条保留线程最多留多少字符的历史，超出截断。 */
    subAgentRetainedHistoryMaxChars: 600_000,
  } as const),
  /** 模型请求的重试与退避：RetryPolicy。 */
  retry: Object.freeze({
    /** 第一次重试前等多少毫秒。 */
    connectionBaseDelayMs: 3_000,
    /** 退避封顶，毫秒：超过这条线不再翻倍，既给瞬态故障留缓冲，又不让用户傻等。 */
    connectionMaxDelayMs: 30_000,
    /** 退避抖动上限（正负），毫秒：多个 worker 同时撞到同一个 endpoint 时分散唤醒。 */
    connectionJitterMs: 750,
    /** 供应方 Retry-After 头允许的最大等待毫秒数：再长按无效值处理，走本地退避。 */
    connectionHeaderMaxDelayMs: 2_147_483_647,
    /** 一次请求最多重试几次连接类故障。 */
    maxConnectionAttempts: 5,
    /** 交给 AI SDK 自己重试几次：固定为 0，重试纪律全部由本包掌握，避免两层各退避一遍。 */
    aiSdkMaxRetries: 0,
    /** 供应方错误正文最多留多少字节进诊断，超出截断。 */
    providerErrorBodyBytes: 64 * 1024,
  } as const),
  /** 上下文预算与用量估算：context-budget、context-usage、ContextUsageCalibrator。 */
  context: Object.freeze({
    /** 安全余量占窗口的百分比：吸收本地估算与供应方计费口径的偏差。 */
    safetyMarginPercent: 4,
    /** 输出预留占上下文窗口的比例。 */
    outputReserveRatio: 0.12,
    /** 输出预留的下限（token）：再小的窗口也要给模型留出基本的成稿空间。 */
    minOutputReserveTokens: 1_024,
    /** 输出预留的上限（token）：超大窗口下不必无谓预留，留给输入侧更多额度。 */
    maxOutputReserveTokens: 32_000,
    /** 撞墙后应急压缩的目标水位（百分比）：比常规压缩更激进，一次腾够空间，免得重试又立刻溢出。 */
    overflowRecoveryTargetPercent: 60,
    /** 历史载荷的诊断刻度（字符）：只用于报警与面板，不能当发送或压缩门限。 */
    payloadCompactionChars: 400_000,
    /** 历史载荷的诊断窗口（字符），与上一项配套。 */
    payloadWindowChars: 500_000,
    /** 字符/token 密度的上界：异常样本也不许把治理器推到完全失明。 */
    maxHistoryCharsPerToken: 8,
    /** 字符/token 密度的下界：异常样本也不许把治理器推到无穷敏感。 */
    minHistoryCharsPerToken: 0.25,
    /** 用户正文超过多少字符就先落持久化引用再进历史。 */
    oversizedUserTextChars: 48_000,
    /** 工具结果没有专门预算时的内联字符预算。 */
    defaultInlineBudgetChars: 8_000,
    /** 当前源码视图最多列出多少条被省略的文件路径；总数另外给。 */
    maxListedOmittedPaths: 40,
  } as const),
  /** 本地 token 估算的校准系数：ContextUsageCalibrator 按实测用量在线修正估算。 */
  calibration: Object.freeze({
    /** 没有任何样本时的初始系数（1 = 完全信任本地估算）。 */
    defaultFactor: 1,
    /** EMA 学习率：每个样本对系数的修正强度，越小越平滑。 */
    learningRate: 0.25,
    /** 系数下界：本地估算再怎么偏大也不许打这么多折。 */
    minFactor: 0.5,
    /** 系数上界：本地估算再怎么偏小也不许放大过头。 */
    maxFactor: 3,
    /** 单个样本残差的下界，防止一次异常样本让系数瞬间跳变。 */
    minResidual: 0.25,
    /** 单个样本残差的上界，同上。 */
    maxResidual: 4,
  } as const),
  /** 逐字符的 token 成本估算表：没有真分词器时按字符类别累加（单位是 token）。 */
  tokenCost: Object.freeze({
    /** 一个 JSON 对象的起止花括号折算多少 token。 */
    objectBoundary: 2,
    /** 一个 JSON 数组的起止方括号折算多少 token。 */
    arrayBoundary: 2,
    /** 一个对象属性的键与分隔符折算多少 token。 */
    propertyOverhead: 1,
    /** 一条消息的固定开销（角色、分隔）折算多少 token。 */
    messageBase: 4,
    /** 一个文本片段的固定开销折算多少 token。 */
    textPartBase: 3,
    /** 一个文件片段的固定开销折算多少 token（含元数据）。 */
    filePartBase: 18,
    /** 一个工具调用或工具结果片段的固定开销折算多少 token。 */
    toolPartBase: 8,
    /** 遇到无法识别的循环结构时按多少 token 记账。 */
    unknownCycle: 8,
    /** 一个换行折算多少 token。 */
    newline: 0.25,
    /** 一个制表符折算多少 token。 */
    tab: 0.25,
    /** 一个 ASCII 标点折算多少 token。 */
    asciiPunctuation: 0.5,
    /** 一个非 ASCII 标点折算多少 token。 */
    nonAsciiPunctuation: 0.75,
    /** 一个 emoji 折算多少 token。 */
    emoji: 2,
    /** 一个中日韩字符折算多少 token。 */
    cjk: 1,
    /** 其余 Unicode 字符折算多少 token。 */
    otherUnicode: 1,
  } as const),
  /** 上下文驻留账本与治理：准入、锚点、骨架、面板、蒸馏。 */
  residency: Object.freeze({
    /** 缺席量纲时按多少字符折算一个 token；凡是能拿到实测密度的地方都必须传实测值，这只是兜底。 */
    defaultCharsPerToken: 4,
    /** 单条记录最多留多少个锚点：再多就是噪声，而且锚点自己也占预算。 */
    maxContextAnchors: 24,
    /** 抽锚点时最多扫正文的多少字符（头尾各半）：MB 级工具输出跑全文正则会卡出可感知的准入延迟。 */
    maxAnchorScanChars: 128_000,
    /** 骨架里单个条目的最大字符数。 */
    skeletonItemMaxChars: 220,
    /** 一份摘要最多代表多少条记录；每个成员都要留下精确召回指针。 */
    maxContextSummaryMembers: 12,
    /** 骨架整体的最大字符数：骨架自己超预算就不叫压缩了。 */
    maxSkeletonChars: 3_200,
    /** 目标提示的最大字符数：它进的是提示词，不是上下文。 */
    maxGoalHintChars: 400,
    /** 治理窗口的提前折扣系数：可用窗口已经扣过安全余量，这里固定为 1，不再二次打折。 */
    governanceHeadroomRatio: 1,
    /** 治理窗口的地板（token）：固定开销已经撑破送核门时的退化取值，保证治理器每轮都能开。 */
    minGovernanceWindowTokens: 1,
    /** 最大持仓榜列几条。 */
    topHoldingCount: 3,
    /** 最近记录的短索引列几条，回答"刚才那批调用落在哪"。 */
    latestHoldingCount: 3,
    /** 并行工具调用的最近片段列几条。 */
    latestParallelToolPartCount: 4,
    /** 每个会话保留多少份 epoch 报告：转交信号只看最近若干次，无限留等于内存泄漏。 */
    maxRetainedEpochReports: 32,
    /** 治理登记处最多同时跟踪多少个会话，超过按最久未用淘汰。 */
    maxTrackedSessions: 128,
    /** 蒸馏产物最多积压几份：产物本身占内存，积压超过几个就说明 epoch 根本没在跑。 */
    maxPendingDistillProducts: 4,
    /** 准入时一般记录内联多少字符，超出转摘录。 */
    admissionInlineMaxChars: 24_000,
    /** 准入时用户正文内联多少字符：用户自己写的话比工具输出值钱，给双倍额度。 */
    admissionUserInlineMaxChars: 48_000,
    /** 准入摘录的最大字符数（头尾各半取窗口）。 */
    admissionExcerptMaxChars: 24_000,
    /** 一次蒸馏喂给模型的最大字符数：段落在规划期就按它切好。 */
    distillMaxInputChars: 48_000,
    /** 蒸馏产物的目标字符数。 */
    distillTargetChars: 2_400,
    /** 一次蒸馏调用的超时，毫秒；到点即判超时并回落骨架。 */
    distillTimeoutMs: 45_000,
    /** 短于多少字符的段落不值得单独折一次蒸馏。 */
    distillMinSegmentChars: 4_000,
    /** 自适应档：叙述短于多少字符就不请蒸馏，机械骨架已经够。 */
    distillMinNarrativeChars: 8_000,
  } as const),
  /** 会话召回与索引：ChatContextRetrievalService、查询轨迹。 */
  retrieval: Object.freeze({
    /** 计数索引最多留多少条目。 */
    countEntryLimit: 4_096,
    /** 索引构建遥测最多按多少个会话分桶。 */
    indexBuildTelemetrySessionLimit: 512,
    /** 一次终端输出召回最多考察多少个候选载荷。 */
    terminalOutputPayloadCandidateLimit: 64,
    /** 内存里最多缓存几个会话的索引快照：快照可达数 MB，宁小勿大。 */
    cachedIndexSessionLimit: 8,
    /** 每个会话最多留多少条最近查询轨迹。 */
    maxRecentQueryTracesPerSession: 24,
    /** 查询计数表最多留多少条目。 */
    maxQueryCountEntries: 4_096,
    /** 索引里单条工具调用的入参序列化上限（字符）：只影响可搜索文本，不影响召回全文。 */
    indexedMessageToolArgsChars: 1_000,
  } as const),
  /** 工具执行与结果整形：ToolExecutor、失败详情、入参投影。 */
  tools: Object.freeze({
    /** 中止后等工具自己收尾多少毫秒，超时按未收尾记账。 */
    abortSettlementGraceMs: 250,
    /** 工具入参按 schema issue 归一化最多重试几遍，仍不通过就报校验失败。 */
    maxArgsNormalizationPasses: 5,
    /** 同时最多并发跑几个声明了并发安全的工具。 */
    maxConcurrentConcurrencySafeTools: 8,
    /** 同一个工具连续失败几次后熔断，不再让模型继续撞。 */
    allocatorFailureBreakerThreshold: 3,
    /** 失败 details 里数组最多留几项。 */
    failureDetailsArrayItems: 10,
    /** 失败 details 里对象最多留几个键。 */
    failureDetailsObjectKeys: 50,
    /** 失败 details 里单个字符串最多留多少字符。 */
    failureDetailsStringChars: 2_000,
    /** 失败 details 最多递归几层。 */
    failureDetailsDepth: 6,
    /** 生成历史占位预览时最多扫入参的几层。 */
    placeholderScanDepth: 6,
    /** 生成历史占位预览时最多扫多少个节点。 */
    placeholderScanNodes: 2_000,
    /** 一次入参宽容修正最多改几处。 */
    maxInputAdjustments: 50,
    /** 入参宽容修正最多递归几层。 */
    maxInputAdjustmentDepth: 32,
    /** 入参宽容修正记录的路径最多多少字符。 */
    maxInputAdjustmentPathChars: 256,
    /** 历史里工具入参投影的总字符上限。 */
    inputHistoryChars: 12_000,
    /** 历史里工具入参投影中单个字符串的上限。 */
    inputHistoryStringChars: 900,
    /**
     * 门的程序正文（`program:run` 入参里的 program）在历史里原样留多长：模型下一轮要照着它写 edits，看不见就改不了。
     * 更长的照常省略、可召回；整份入参仍受 inputHistoryChars 管，所以这里要比它小。
     */
    programHistoryChars: 10_000,
    /** 历史里工具入参投影中单个数组最多留几项。 */
    inputHistoryArrayItems: 100,
    /** 历史里工具入参投影最多记几条省略说明。 */
    inputHistoryOmissions: 100,
    /** 工具输出句柄没给投影长度时按多少字符投影。 */
    outputProjectionChars: 24_000,
    /** 模型档序列化最多递归几层。 */
    modelResultDepth: 8,
    /** 模型档序列化里单个数组最多留几项：真正的闸门是字符预算，这一项只兜底"海量小条目"。 */
    modelResultArrayItems: 400,
    /** 召回档（持久化全保真）序列化最多递归几层。 */
    recallResultDepth: 12,
    /** 召回档序列化里单个数组最多留几项：写入时裁剪等于永久销毁，所以这一档只做防爆兜底。 */
    recallResultArrayItems: 5_000,
    /** 工具空间页表档序列化最多递归几层：页表是元数据，裁深了模型就不知道怎么换页。 */
    toolSpaceResultDepth: 18,
    /** 工具空间页表档序列化里单个数组最多留几项。 */
    toolSpaceResultArrayItems: 80,
    /** 界面展示档序列化最多递归几层。 */
    displayResultDepth: 8,
    /** 界面展示档序列化里单个数组最多留几项。 */
    displayResultArrayItems: 20,
    /** 恢复失败调用的原参数时最多展示多少字符，更大的保持省略形态由模型按需召回。 */
    restoredInputChars: 32_000,
  } as const),
  /** 工具契约套件：说明体积与 schema 组装。 */
  toolkit: Object.freeze({
    /** 工具发现打分低于最高分的多少比例就算低置信，标记给模型。 */
    lowConfidenceScoreRatio: 0.3,
  } as const),
  /** 子 Agent 派发与进展账本：SubAgentDispatcher、SubAgentProgressLedger。 */
  delegation: Object.freeze({
    /** 同一时刻最多并发跑几个子 Agent。 */
    maxConcurrentSubAgents: 4,
    /** 一次执行里累计最多派发多少个子 Agent。 */
    maxSubAgentsPerExecution: 32,
    /** 子 Agent 遇到瞬态故障最多重试几次。 */
    transientRetryMaxAttempts: 2,
    /** 回报给主 Agent 的同厂商可选模型最多列几个：聚合厂商的目录可能很长。 */
    maxReportedSelectableModels: 24,
    /** 单个子 Agent 的进展摘要最多记几行，超过停记并留一条说明。 */
    maxDigestLines: 200,
    /** 单条发现的最大字符数。 */
    findingsMaxCharsEach: 480,
    /** 最多留几条发现。 */
    findingsMaxRecords: 8,
    /** 同一条任务描述最多重复派发几次，防止模型原地打转。 */
    maxIdenticalDispatches: 3,
    /** 针对同一个目标最多跑几轮。 */
    maxRoundsPerTarget: 4,
    /** 进展账本最多留多少条目（远大于派发硬上限，只作内存安全兜底）。 */
    maxLedgerEntries: 32,
    /** 续跑失败原因最多带多少字符进下一轮指令。 */
    resumeFailureReasonChars: 200,
  } as const),
  /** 运行档与角色：按模型窗口与工具规模判档。 */
  runProfile: Object.freeze({
    /** 模型窗口未知时按多少 token 判档。 */
    unknownContextWindowTokens: 128_000,
    /** 窗口达到多少 token 起算"均衡"档。 */
    balancedContextWindowTokens: 192_000,
    /** 窗口达到多少 token 起算"扩展"档。 */
    expandedContextWindowTokens: 1_000_000,
    /** 单个工具最多能拿到多少热度分减免；上限约一个档，避免热工具完全压倒能力分级。 */
    maxToolHotnessBoost: 80,
    /** 每被用一次加多少热度分。 */
    toolHotnessUnit: 8,
    /** 常驻工具额外加多少分。 */
    toolResidentBoost: 1_500,
    /** 工具数超出软上限多少比例之内还算可接受。 */
    toolCountSoftOverageRatio: 0.15,
    /** 工具数软超额至少允许几个，避免小基数下比例失效。 */
    toolCountSoftOverageMin: 2,
    /** compact 档最多长期携带几个工具。 */
    compactMaxToolCount: 32,
    /** compact 档的系统提示词字符上限。 */
    compactMaxSystemPromptChars: 80_000,
    /** compact 档的输入工作集上限（token）。 */
    compactMaxInputWorkingSetTokens: 48_000,
    /** compact 档的工具 schema 字符上限。 */
    compactMaxToolSchemaChars: 48_000,
    /** balanced 档最多长期携带几个工具。 */
    balancedMaxToolCount: 64,
    /** balanced 档的系统提示词字符上限。 */
    balancedMaxSystemPromptChars: 220_000,
    /** balanced 档的输入工作集上限（token）。 */
    balancedMaxInputWorkingSetTokens: 96_000,
    /** balanced 档的工具 schema 字符上限。 */
    balancedMaxToolSchemaChars: 96_000,
    /** expanded 档最多长期携带几个工具（该档不限系统提示词字符，所以没有对应项）。 */
    expandedMaxToolCount: 128,
    /** expanded 档的输入工作集上限（token）。 */
    expandedMaxInputWorkingSetTokens: 192_000,
    /** expanded 档的工具 schema 字符上限。 */
    expandedMaxToolSchemaChars: 192_000,
  } as const),
  /** 提示词组装与回合载荷：ContextBuilder、TurnPayload、技能。 */
  prompt: Object.freeze({
    /** mod 追加的回合上下文段的缺省优先级：排在内置动态段之后，便于识别来源。 */
    modTurnContextPriority: 9_000,
    /** 内置技能没声明优先级时的默认排序优先级（升序靠前）。 */
    builtinSkillPriority: 100,
    /** 用户技能的默认排序优先级（升序靠前），故意低于内置目录的 100。 */
    userFileSkillPriority: 60,
    /** 提示词里最多列几个自定义子 Agent。 */
    maxCustomSubAgentEntries: 12,
    /** 调试期重复用户提示词超过多少字符就折叠。 */
    repeatedDebugPromptElideChars: 2_000,
    /** 折叠后保留多少字符的预览。 */
    repeatedDebugPromptPreviewChars: 120,
    /** 会话提示词缓存键最多取前缀的多少字符。 */
    sessionPromptCacheKeyPrefixChars: 48,
  } as const),
  /** 执行记录、事件与后台任务：ExecutionStore、KernelBackgroundJobManager、回合上下文账本。 */
  records: Object.freeze({
    /** 每条执行最多留多少个事件，超过从最早的丢。 */
    executionEventRetentionLimit: 500,
    /** 最多留多少条执行记录。 */
    executionRecordRetentionLimit: 200,
    /** 助手输出摘要最多留多少字符。 */
    assistantOutputSummaryChars: 500,
    /** 已结束的后台任务保留多久，毫秒。 */
    terminalJobTtlMs: 10 * 60 * 1_000,
    /** 已结束的后台任务最多留多少条。 */
    terminalJobLimit: 200,
    /** 后台任务多久没有新输出就算停滞，毫秒。 */
    backgroundJobStalledAfterMs: 120_000,
    /** 单条回合上下文账本最多留多少条目。 */
    turnContextLedgerMaxEntries: 100,
    /** 最多同时为多少个会话保留回合上下文账本。 */
    turnContextMaxSessions: 64,
    /** 列会话资源时没给 limit 返回多少条。 */
    sessionListDefaultLimit: 100,
    /** 列会话资源时 limit 的上界，调用方给更大的值一律夹回。 */
    sessionListMaxLimit: 1_000,
  } as const),
  /** 会话工作态：CodingSessionTracker。 */
  session: Object.freeze({
    /** 外部改动触发的刷新最短间隔，毫秒：抖动期内的多次事件合成一次。 */
    externalTouchCooldownMs: 750,
  } as const),
  /** 流式诊断与生成产物。 */
  stream: Object.freeze({
    /** 原始流诊断最多采样几片，用来定位供应方协议问题。 */
    maxRawDiagnosticSamples: 8,
    /** 单个生成产物最多多少字节，超过不再落盘也不进历史。 */
    maxGeneratedFileBytes: 20 * 1024 * 1024,
    /** 渲染侧聊天流日志最多留多少条。 */
    sessionLogCapacity: 10_000,
  } as const),
  /** mod 加载、接缝与归档扫描。 */
  mods: Object.freeze({
    /** 接缝诊断最多留多少条。 */
    maxSeamDiagnostics: 200,
    /** hook 没声明优先级时排在哪一档（升序靠前）。 */
    defaultHookPriority: 100,
    /** hook 没给超时时等多少毫秒。 */
    defaultHookTimeoutMs: 5_000,
    /** hook 超时允许的最小值，毫秒。 */
    minimumHookTimeoutMs: 100,
    /** hook 超时允许的最大值，毫秒。 */
    maximumHookTimeoutMs: 30_000,
    /** 归档扫描会话多久没人续用就丢弃，毫秒。 */
    scanSessionTtlMs: 10 * 60 * 1000,
  } as const),
  /** 外部连接：MCP 客户端、审批参数预览。 */
  connectors: Object.freeze({
    /** 审批弹窗里参数预览最多多少字符。 */
    approvalPreviewChars: 4_000,
    /** 审批弹窗里单个字符串字段最多多少字符。 */
    approvalStringChars: 400,
  } as const),
  /** 产品会话归档与搜索。 */
  productSession: Object.freeze({
    /** 归档没给上限时最多带多少条资源。 */
    archiveMaxResources: 1_000,
    /** 归档没给上限时最多带多少条事件。 */
    archiveMaxEvents: 100_000,
    /** 会话搜索没给上限时最多取几个关键词。 */
    sessionSearchMaxTerms: 12,
  } as const),
} as const)
