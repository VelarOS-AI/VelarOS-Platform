/**
 * 约定的常量表（对外合同的一部分）：工具身份与类别、包与能力身份、协议版本、错误码、环境变量表，以及模型和宿主都看得到的上限。
 *
 * 宿主按这里的名字挂工具、按错误码判断失败、按环境变量表配置本包；上限直接被工具说明与 schema 引用，是模型看到的数字，
 * 改了等于改契约，要同时更新差量报告与下游快照。包内可调、不对外承诺的参数不在这里，在 `utils/tuning.ts`。
 *
 * 本文件不 import 任何东西、不用 Node 专属类型，随可移植入口整份出包。
 */

/**
 * 内置的二十个模型面工具的 canonical 名字，外加租约协议自恢复用的两个发现工具名。
 *
 * 工具名是契约：宿主按它挂载、模型按它调用、账本按它归档，改名等于换一个工具。
 */
export const AgentToolNames = Object.freeze({
  /** 工具空间总览：按类别列出当前可见工具与它们的换入状态。 */
  toolingMap: 'tooling:map',
  /** 读一个工具的完整说明与入参 schema。 */
  toolingRead: 'tooling:read',
  /** 整体替换当前常驻的工具类别集合。 */
  toolingReplace: 'tooling:replace',
  /** 按条件召回本会话已经产生过的上下文（工具结果、用户正文、终端输出）。 */
  contextRecall: 'context:recall',
  /** 把当前会话的上下文转交给一条新会话继续。 */
  contextHandoff: 'context:handoff',
  /** 声明本轮已经消化完的内容，让旧结果折叠成可召回的句柄。 */
  contextDistill: 'context:distill',
  /** 列出当前生效的长期指令。 */
  directiveList: 'directive:list',
  /** 新增或改写一条长期指令。 */
  directiveUpsert: 'directive:upsert',
  /** 归档一条长期指令，让它不再进入提示词。 */
  directiveArchive: 'directive:archive',
  /** 读当前目标。 */
  goalGet: 'goal:get',
  /** 建立当前目标。 */
  goalCreate: 'goal:create',
  /** 更新当前目标的状态或内容。 */
  goalUpdate: 'goal:update',
  /** 读当前计划。 */
  planGet: 'plan:get',
  /** 更新当前计划的步骤与生命周期。 */
  planUpdate: 'plan:update',
  /** 派发一个有界子任务给子 Agent。 */
  agentDispatch: 'agent:dispatch',
  /** 按工作流 IR 跑一轮多 Agent 编排。 */
  agentRunWorkflow: 'agent:run_workflow',
  /** 读一个后台任务当前已经产出的输出。 */
  jobReadOutput: 'job:read_output',
  /** 等一批后台任务收尾。 */
  jobWait: 'job:wait',
  /** 取消一个后台任务。 */
  jobCancel: 'job:cancel',
  /** 向用户要一次确认。 */
  interactionConfirm: 'interaction:confirm',
  /** 租约自恢复：拉取当前完整工具目录（不在二十个内置工具里，由租约协议直接消费）。 */
  toolingCatalog: 'tooling:catalog',
  /** 租约自恢复：按需拉取某个工具的精确入参 schema（同上）。 */
  toolingSchema: 'tooling:schema',
} as const)

export type AgentToolName = (typeof AgentToolNames)[keyof typeof AgentToolNames]

/**
 * 每个内置工具所属的唯一职责类别：Agent 自身控制、上下文、规划、与用户交互。
 *
 * 类别是工具空间换入换出的最小单位，宿主与模型都按类别整组开关。
 */
export const AgentToolCategoryByName = Object.freeze({
  [AgentToolNames.toolingMap]: 'agent-control',
  [AgentToolNames.toolingRead]: 'agent-control',
  [AgentToolNames.toolingReplace]: 'agent-control',
  [AgentToolNames.agentDispatch]: 'agent-control',
  [AgentToolNames.agentRunWorkflow]: 'agent-control',
  [AgentToolNames.jobReadOutput]: 'agent-control',
  [AgentToolNames.jobWait]: 'agent-control',
  [AgentToolNames.jobCancel]: 'agent-control',
  [AgentToolNames.contextRecall]: 'context',
  [AgentToolNames.contextHandoff]: 'context',
  [AgentToolNames.contextDistill]: 'context',
  [AgentToolNames.directiveList]: 'context',
  [AgentToolNames.directiveUpsert]: 'context',
  [AgentToolNames.directiveArchive]: 'context',
  [AgentToolNames.goalGet]: 'planning',
  [AgentToolNames.goalCreate]: 'planning',
  [AgentToolNames.goalUpdate]: 'planning',
  [AgentToolNames.planGet]: 'planning',
  [AgentToolNames.planUpdate]: 'planning',
  [AgentToolNames.interactionConfirm]: 'interaction',
} as const)

export type AgentToolCategoryId = (typeof AgentToolCategoryByName)[keyof typeof AgentToolCategoryByName]

/**
 * 本包在宿主里的几个固定身份：内置 mod、内核模块、能力令牌、执行权限、远程宿主工具类别。
 *
 * 宿主的权限策略与 mod 清单按这些串写死，改名会让已经装好的 mod 与已经授过的权限全部失配。
 */
export const AgentIdentity = Object.freeze({
  /** 内置 mod 的 id：内置工具、类别与 seam 都挂在它下面。 */
  builtinModId: 'velaros.agent.builtin',
  /** 作为内核模块挂进 Kernel 时的模块 id，宿主的权限策略按它授权。 */
  kernelModuleId: 'velaros.agent.runtime',
  /** 内核能力令牌的身份串；宿主按它取到 Agent 能力服务。 */
  capabilityId: 'velaros.agent',
  /** 经内核执行一次 Agent 请求所需的权限名。 */
  executionPermission: 'agent:execute',
  /** 远程宿主工具统一挂到这个工具类别下。 */
  remoteHostToolCategory: 'remote-host',
  /** 远程节点 MCP 服务对外报出的服务名。 */
  remoteNodeMcpServerName: 'velaros-remote-host',
} as const)

/**
 * 本包各条协议各自的版本号。
 *
 * 每条协议单独计数、互不牵连：wire 面解析时按对应版本严格比对，版本不符直接拒收而不是宽容降级。
 */
export const AgentProtocolVersions = Object.freeze({
  /** Agent 工具契约（租约、目录、调用信封）的协议版本，与 Kernel 的 wire 版本无关。 */
  agent: 1,
  /** Agent 能力执行信封（`AgentCapabilityExecuteEnvelope`）的协议版本。 */
  agentCapability: 1,
  /** 外部 Agent 桥（回环 TCP）的协议版本。 */
  externalAgentBridge: 2,
  /** 聊天持久化 manifest 的基线版本，测试版发布起算。 */
  chatStorageSchema: 1,
  /** mod 领域清单（`velaros.mod.json` 的 agent 节）的 schema 版本。 */
  agentModManifestSchema: 1,
  /** 产品会话归档信封的 schema 版本。 */
  sessionArchiveSchema: 1,
  /** 会话召回索引快照的版本；版本不同的旧快照一律重建。 */
  contextRetrievalIndex: 2,
} as const)

/** Agent 能力的对外 API 版本（语义化版本串，与协议版本号分开报）。 */
export const AgentCapabilityApiVersionString = '1.0.0' as const

/**
 * 本包对外承诺的错误语义。
 *
 * 失败关闭是默认姿态：条件不足时拒绝执行并报码，不静默降级。外面一律按码分支，不许按报错文案匹配——
 * 文案会随中文化和措辞调整变化，码不会。
 */
export const AgentErrorCodes = Object.freeze({
  /** 上下文纪元已经翻页，这次工具结果属于上一纪元，不许再写回当前账本。 */
  contextEpochStale: 'KERNEL_CONTEXT_EPOCH_STALE',
  /** 这次执行被中断（用户取消、会话关停、上层 abort）。 */
  executionAborted: 'EXECUTION_ABORTED',
  /** 审批被拒：用户或策略明确拒绝了这次调用。 */
  executionDenied: 'EXECUTION_DENIED',
  /** 还有一次交互在等用户答复，本次执行不能继续。 */
  executionInteractionPending: 'EXECUTION_INTERACTION_PENDING',
  /** 供应方返回了空回复，没有可用正文也没有工具调用。 */
  modelEmptyResponse: 'MODEL_EMPTY_RESPONSE',
  /** 供应方流式回复中途停住，超过空闲阈值仍无新片。 */
  modelStreamStalled: 'MODEL_STREAM_STALLED',
  /** 供应方流式回复被连接层打断。 */
  modelStreamInterrupted: 'MODEL_STREAM_INTERRUPTED',
  /** 供应方输出在到达上限时被截断，正文不完整。 */
  modelOutputTruncated: 'MODEL_OUTPUT_TRUNCATED',
  /** 工具结果收尾（句柄化、持久化、投影）失败，结果没有进入历史。 */
  toolResultFinalizationFailed: 'TOOL_RESULT_FINALIZATION_FAILED',
  /** 当前能力范围里没有这个工具类别，工具不可用（不是"没找到"，也不是"被拒"）。 */
  toolUnavailable: 'AGENT_TOOL_UNAVAILABLE',
} as const)

export type AgentErrorCode = (typeof AgentErrorCodes)[keyof typeof AgentErrorCodes]

/**
 * 本包读取的环境变量。
 *
 * 环境变量也是注入：先登记再用，宿主按这张表配置本包；没登记的名字门禁会拦。
 */
export const AgentEnvironmentVariables = Object.freeze({
  /** 上下文用量估算用哪个分词引擎。 */
  tokenizerEngine: Object.freeze({
    name: 'VELAROS_TOKENIZER_ENGINE',
    direction: 'input',
    description: '选择上下文用量估算的分词引擎；不设时退回包内按字符类别累加的启发式估算。',
  }),
  /** 远程节点 MCP stdio 入口要连到哪个远程节点。 */
  remoteNodeUrl: Object.freeze({
    name: 'VELAROS_REMOTE_NODE_URL',
    direction: 'input',
    description: '远程节点的地址；`velaros-remote-host` 这个 stdio 入口启动时必须有它，缺席直接拒绝启动。',
  }),
  /** 远程节点首次配对用的配对码。 */
  remoteNodePairingCode: Object.freeze({
    name: 'VELAROS_REMOTE_NODE_PAIRING_CODE',
    direction: 'input',
    description: '首次与远程节点配对时出示的配对码；已经配过、凭据仍在有效期内时可以不设。',
  }),
} as const)

export type AgentEnvironmentVariable = (typeof AgentEnvironmentVariables)[keyof typeof AgentEnvironmentVariables]

/**
 * 一次执行允许跑多少步：主 Agent 与团队各一套上下限。
 *
 * 步数是模型能看到、也能在派发参数里指定的数字，超出区间一律夹回，不报错。
 */
export const AgentStepLimits = Object.freeze({
  /** 单次执行最少跑一步：夹的下限，给 0 或负数时按它算。 */
  minExecutionSteps: 1,
  /** 单次执行最多跑多少步，防止单条会话无限循环。 */
  maxExecutionSteps: 100,
  /** 团队里单个 worker 没指定步数时给多少步。 */
  defaultTeamWorkerSteps: 50,
  /** 一次团队编排没指定总步数时给多少步。 */
  defaultTeamMaxSteps: 300,
  /** 一次团队编排最多跑多少步（所有 worker 合计）。 */
  maxTeamSteps: 1000,
} as const)

/**
 * 工具契约租约的续租纪律。
 *
 * 宪章 §10 守护清单的校准值，原样带走、禁止顺手重估；只能被新实验推翻，不能被新架构删除。
 */
export const AgentLeasePolicy = Object.freeze({
  /** 一份租约最多用多久就必须强制续租，毫秒。 */
  renewalWindowMs: 10 * 60 * 1000,
  /** 一份租约最多跨多少个回合就必须强制续租。 */
  renewalTurnLimit: 6,
} as const)

/**
 * 外部 Agent 桥（回环 TCP）的对外约定：地址、端口区间、单帧上限、配对与队列纪律。
 *
 * 桥只在本机回环上监听；这些数字是对接方（Termel、Desktop）按之实现的协议约束，不是包内可调参数。
 */
export const ExternalAgentBridgeLimits = Object.freeze({
  /** 只在本机回环地址上监听，绝不对外暴露。 */
  host: '127.0.0.1',
  /** 端口区间下界：从这里开始找空闲端口。 */
  portRangeStart: 43_137,
  /** 端口区间上界（含）：到这里还找不到空闲端口就报错，不随便挑别的端口。 */
  portRangeEnd: 43_147,
  /** 单帧最大字节数，超过直接断开，防止对端用一帧撑爆内存。 */
  maxSocketPayloadBytes: 32 * 1_024 * 1_024,
  /** 未确认命令队列最多堆多少条，超过按背压拒收。 */
  maxCommands: 100,
  /** 已处理事件窗口保留多少条，用于去重与重放判定。 */
  maxProcessedEvents: 256,
  /** 一份配对码的有效期，毫秒。 */
  pairingLifetimeMs: 5 * 60_000,
  /** 同一来源连续配对失败多少次后进入封禁。 */
  pairingMaxFailures: 5,
  /** 配对失败超限后的封禁时长，毫秒。 */
  pairingBlockMs: 30_000,
} as const)

/**
 * `.velarmod` 归档导入的硬上限。
 *
 * 归档来自外部，全部上限都是安全边界而不是调优项：任何一条越界一律拒载并留诊断，不做部分导入。
 */
export const VelarModArchiveLimits = Object.freeze({
  /** 归档文件本身最大字节数。 */
  maxArchiveBytes: 32 * 1024 * 1024,
  /** 解压后总字节数上限，配合压缩比一起防压缩炸弹。 */
  maxExpandedBytes: 128 * 1024 * 1024,
  /** 清单文件最大字节数。 */
  maxManifestBytes: 256 * 1024,
  /** 归档里最多允许多少个文件。 */
  maxFileCount: 512,
  /** 允许的最大压缩比（解压后 ÷ 归档），超过按压缩炸弹拒载。 */
  maxCompressionRatio: 100,
  /** 归档内单条路径的最大字符数。 */
  maxPathLength: 240,
  /** 归档内路径的最大层级深度。 */
  maxPathDepth: 8,
} as const)

/**
 * 写进工具说明与入参 schema 的上限：模型能直接看到这些数字，改了就是改模型面。
 *
 * 每一项都必须与工具 schema 里实际生效的 `.max()` / `.default()` 一致；只改一边会让说明骗模型。
 */
export const AgentToolLimits = Object.freeze({
  /** 工具空间查询（`tooling:map`）。 */
  toolSpace: Object.freeze({
    /** 一页最多返回多少条，模型给更大的值一律夹回。 */
    queryPageLimitMax: 50,
    /** 类别、领域这类短标识的最大字符数。 */
    identifierChars: 120,
    /** 单条摘要文本的最大字符数。 */
    summaryChars: 240,
    /** 一次查询最多给几个筛选词。 */
    filterTerms: 8,
    /** 目标工具行数：一次给模型看多少行工具索引。 */
    targetToolRows: 32,
  }),
  /** 长期指令（`directive:*`）。 */
  directives: Object.freeze({
    /** 同时生效的长期指令条数上限，满了必须先归档或合并。 */
    maxActive: 20,
  }),
  /** 上下文蒸馏与转交（`context:distill`、`context:handoff`）。 */
  context: Object.freeze({
    /** 单条蒸馏事实的最大字符数。 */
    distilledFactChars: 240,
    /** 一次蒸馏最多留多少条事实。 */
    distilledFactCount: 20,
    /** 蒸馏附言的最大字符数。 */
    distillNoteChars: 300,
    /** 转交理由的最大字符数。 */
    handoffReasonChars: 400,
  }),
  /** 会话召回（`context:recall`）。 */
  recall: Object.freeze({
    /** 没给 maxChars 时一次返回多少字符。 */
    defaultRetrieveChars: 8_000,
    /** 一次召回允许返回的最大字符数，模型给更大的值一律夹回。 */
    maxRetrieveChars: 30_000,
    /** maxChars 的下界：再小也要给够一条能读懂的片段。 */
    minRetrieveChars: 1_000,
    /** 没给 maxResults 时返回多少条搜索结果。 */
    defaultSearchResults: 8,
    /** 一次搜索最多返回多少条结果。 */
    maxSearchResults: 20,
  }),
  /** 后台任务（`job:*`）。 */
  jobs: Object.freeze({
    /** `job:wait` 没给 timeout_ms 时等多久，毫秒。 */
    defaultWaitTimeoutMs: 120_000,
    /** 一次读取后台任务输出最多返回多少字符。 */
    outputMaxChars: 64 * 1024,
    /** 任务列表里单条预览的最大字符数。 */
    previewMaxChars: 2_000,
  }),
  /** 多 Agent 编排（`agent:run_workflow`）。 */
  workflow: Object.freeze({
    /** 一次工作流最多编排多少个 Agent。 */
    maxAgents: 8,
    /** 一次工作流最多跑多少轮。 */
    maxRounds: 6,
    /** 工作流里单个值的最大字节数。 */
    maxValueBytes: 32 * 1024,
  }),
  /** 子 Agent 结构化输出（`agent:dispatch` 的 schema 约束）。 */
  structuredOutput: Object.freeze({
    /** 结构化输出正文的最大字节数。 */
    maxBytes: 64 * 1024,
    /** 调用方给的输出 schema 的最大字节数。 */
    maxSchemaBytes: 16 * 1024,
    /** 输出 schema 的最大嵌套深度。 */
    maxSchemaDepth: 8,
    /** 输出 schema 单层最多多少个属性。 */
    maxSchemaProperties: 64,
    /** 输出 schema 单个枚举最多多少个取值。 */
    maxSchemaEnumValues: 64,
  }),
  /** 工具结果与入参在模型面的体积。 */
  payload: Object.freeze({
    /** 一条工具结果序列化给模型时的最大字符数，超出转成可召回的句柄。 */
    modelToolResultChars: 32_000,
    /** `recursive=true` 但没给 maxDepth 时的默认遍历深度上限。 */
    defaultRecursiveMaxDepth: 8,
    /** 一次 schema 发现最多返回多少个工具名。 */
    schemaDiscoveryNames: 12,
  }),
} as const)

/**
 * 宿主看得到的上下文水位线（百分比），Desktop 的用量条与实验分臂按它读。
 *
 * 口径是「占可用输入容量的百分比」：恰好装满仍可发送，超出才触发治理。
 */
export const AgentContextThresholds = Object.freeze({
  /** 界面提醒线：到这个百分比只提示接近容量，不触发任何压缩。 */
  highWatermarkPercent: 90,
  /** 自动治理线：完整请求超过可用输入容量的这个百分比才开始治理。 */
  compactionPercent: 100,
} as const)

/**
 * 回合上下文块在提示词里的固定格式标记。
 *
 * 这几个串会逐字进模型上下文，也被 Desktop 的渲染侧按之切块；改一个字符就是改模型面与渲染面两处。
 */
export const TurnContextFormat = Object.freeze({
  /** 动态提示词层的分层标记，贴在当前回合的活动尾开头。 */
  dynamicLayerMarker: '[system prompt · dynamic layer (current turn)]',
  /** 用户超长正文被持久化后，在历史里占位的工具名。 */
  userTextPayloadToolName: '__context_user_text__',
} as const)

/**
 * 工具传输名的对外约定。
 *
 * 供应方对工具名的字符集比 canonical 名严格，发请求前要按这个模式改写并在回传时还原。
 */
export const AgentToolTransport = Object.freeze({
  /** 供应方可接受的工具名字符模式（正则源码串，不带定界符与修饰符）。 */
  providerToolNamePattern: '^[a-zA-Z0-9_-]+$',
} as const)

/**
 * 技能文件在磁盘上的固定名字。
 *
 * 技能目录是用户可见、可手改的，文件名属于对外约定。
 */
export const AgentSkillFiles = Object.freeze({
  /** 技能目录里技能正文的文件名。 */
  skillEntryFileName: 'SKILL.md',
  /** 记录哪些技能被用户停用的状态文件名。 */
  disabledStateFileName: '.disabled-skills.json',
} as const)
