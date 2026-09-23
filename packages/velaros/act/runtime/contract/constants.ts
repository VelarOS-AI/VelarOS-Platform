/** MCP 连接和请求的缺省时限。 */
export const McpLimits = Object.freeze({
  /** 建立连接的缺省时限，毫秒。 */
  connectTimeoutMs: 30_000,
  /** 单次调用的缺省时限，毫秒。 */
  callTimeoutMs: 120_000,
})

/** 装配层稳定身份。 */
export const VelarosRuntimeContract = Object.freeze({
  /** 标准模块契约代际。 */
  schemaRevision: '16',
  /** 标准模块实例代际。 */
  generation: 1,
})

/** 协议接收的有界默认值。 */
export const ScriptProtocolLimits = Object.freeze({
  /** 单条协议响应字符上限。 */
  maxChars: 512_000,
  /** 单条控制头字符上限。 */
  maxHeaderChars: 32_768,
  /** 单次响应声明块上限。 */
  maxBlocks: 32,
  /** 后台脚本默认并发数。 */
  concurrency: 4,
})

/** 主干缺省预算，覆盖模型回合、请求投影和恢复材料。 */
export const VelarosRunLimits = Object.freeze({
  /** 一次用户运行最多推进的模型回合。 */
  turns: 10_000,
  /** 每次请求预留输出。 */
  outputTokens: 4_096,
  /** 编码和计数的独立误差余量。 */
  safetyTokens: 1_024,
  /** 单次构造活动投影的字符硬上限。 */
  projectionChars: 1_000_000,
  /** 恢复视图的原文摘录上限。 */
  recoveryChars: 6_000,
  /** 一次运行的墙钟上限。 */
  timeoutMs: 86_400_000,
})

/** 主线不设总额，只限每小时用量，好让会话一直跑下去；宿主可以另设用户总上限。按真实调用逐次预留，不改变模型窗口。 */
export const VelarosMainBudget = Object.freeze({
  /** 一个逻辑任务中主线与支线累计调用上限；缺省不限。 */
  modelCalls: Number.MAX_SAFE_INTEGER,
  /** 一个逻辑任务累计预留和实际 token 上限；缺省不限。 */
  modelTokens: Number.MAX_SAFE_INTEGER,
  /** 主线及其业务子任务、模型工具每小时的 token 上限（滚动一小时）。 */
  modelTokensPerHour: 30_000_000,
})

/** 业务子任务保留足够的独立工作空间，同时受祖先的剩余额度约束。 */
export const VelarosAgentBudget = Object.freeze({
  /** 一个业务子任务及其模型工具的累计调用上限。 */
  modelCalls: 512,
  /** 一个业务子任务及其模型工具的累计 token 上限。 */
  modelTokens: 4_000_000,
})

/** 业务支线的缺省一次运行预算；宿主可以按任务配置覆盖。 */
export const VelarosAgentRunLimits = Object.freeze({
  ...VelarosRunLimits,
  /** 一次业务子任务最多推进的模型回合。 */
  turns: 256,
  /** 一次业务子任务的墙钟上限，毫秒。 */
  timeoutMs: 3_600_000,
})

/** 主线与模型工具共享的调度缺省上限。 */
export const ModelToolLimits = Object.freeze({
  /** 根为 0，业务子任务为 1，其单一职责工具为 2。 */
  maxDepth: 2,
  /** 每个父会话累计业务工具数。 */
  maxChildren: 256,
  /** 根会话累计业务工具数。 */
  maxSessions: 1_024,
  /** 真正在模型服务中执行的调用数。 */
  concurrency: 4,
})

/** 整理任务可由宿主覆盖的缺省资源档位。 */
export const ContextMaintenanceLimits = Object.freeze({
  /** 含最后直接交付轮的最大调用数。 */
  modelCalls: 24,
  /** 累计预留 token 上限。 */
  modelTokens: 1_000_000,
  /** 在探索之前保留的最终报告请求额度。 */
  finalizationTokens: 65_536,
  /** 单次探索请求的毫秒上限。 */
  callTimeoutMs: 120_000,
  /** 最后一轮交付预留毫秒数。 */
  finalizationMs: 90_000,
  /** 一次整理活动的总毫秒上限。 */
  timeoutMs: 1_200_000,
  /** 每次输出 token 上限。 */
  outputTokens: 8_192,
  /** 整理会话的活动正文字符上限。 */
  projectionChars: 64_000,
  /** 一次整理最多读取的原文字符数。 */
  readChars: 2_000_000,
  /** 目录和原文访问次数上限。 */
  reads: 256,
})

/** 整理材料分页的缺省容量与单页上限（上限写在 velaros:context-materials 的声明里）。 */
export const ContextMaintenanceReadLimits = Object.freeze({
  /** 默认正文页字符数。 */
  pageChars: 12_000,
  /** 单页正文字符上限。 */
  maxPageChars: 32_000,
  /** 默认元数据页条目数。 */
  pageItems: 32,
  /** 单页元数据条目上限。 */
  maxPageItems: 64,
})

/** 声明式入口的缺省运行窗口预算，宿主可按真实模型覆盖。 */
export const RuntimeModelLimits = Object.freeze({
  /** 运行时采用的总窗口预算。 */
  contextTokens: 128_000,
  /** 请求输入预算。 */
  inputTokens: 110_000,
  /** 每轮输出预留。 */
  outputTokens: 12_000,
})
/** 常规项目搜索的有界档位，预留最终交付空间。 */
export const RuntimeSearchProfile = Object.freeze({
  /** 含最终交付轮的请求上限。 */
  modelCalls: 24,
  /** 累计 token 预算。 */
  modelTokens: 1_000_000,
  /** 预留最终交付额度。 */
  finalizationTokens: 65_536,
  /** 活动总毫秒上限。 */
  timeoutMs: 1_200_000,
  /** 单次请求毫秒上限。 */
  callTimeoutMs: 120_000,
  /** 最后交付轮预留毫秒。 */
  finalizationMs: 90_000,
  /** 单次输出 token 上限。 */
  outputTokens: 8_192,
  /** 搜索活动投影的字符上限。 */
  projectionChars: 48_000,
  /** 来源查询次数上限。 */
  sourceQueries: 128,
  /** 候选目标数量上限。 */
  candidates: 256,
  /** 真实证据读取次数上限。 */
  reads: 128,
  /** 真实证据读取字节上限。 */
  readBytes: 2_000_000,
})
