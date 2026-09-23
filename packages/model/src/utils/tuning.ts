/** model 包内可调的数字：超时、缓存、预算与截断长度，按用途分组，改这里一处就够。 */
export const ModelTuning = Object.freeze({
  /** 远端模型目录发现。 */
  catalog: Object.freeze({
    /** 一次 `/models` 请求的硬超时，毫秒。 */
    requestTimeoutMs: 15_000,
    /** 一份成功目录快照的存活时长，毫秒。 */
    cacheTtlMs: 300_000,
    /** 一份失败目录快照的存活时长，毫秒；短一点，好让用户配好后很快能重试。 */
    errorCacheTtlMs: 30_000,
    /** 目录缓存最多保留几份快照，超了从最旧的开始丢。 */
    cacheEntries: 128,
    /** 服务端错误正文带进错误文案的最多字符数，避免把整页 HTML 抄进日志。 */
    errorMessageChars: 160,
    /** Google `/models` 一页要多少条。 */
    googlePageSize: 1000,
  }),
  /** 磁盘与内存 provider script。 */
  scripts: Object.freeze({
    /** 探测一次 provider script 运行时元数据的硬上限，毫秒。 */
    runtimeMetadataTimeoutMs: 15_000,
  }),
  /** 用户上传的自定义 JS adapter 沙箱。 */
  userAdapter: Object.freeze({
    /** 沙箱里一段脚本的执行墙，毫秒；同步死循环靠它打断。 */
    executionTimeoutMs: 1000,
    /** 已求值 adapter 的缓存条数，超了从最旧的开始丢。 */
    evaluationCacheEntries: 16,
  }),
  /** 思考深度与思考力度到各家 reasoning 参数的换算。 */
  reasoning: Object.freeze({
    /** fast 档在没有输出预算可换算时的 thinking budget，token。 */
    budgetFast: 2048,
    /** balanced 档在没有输出预算可换算时的 thinking budget，token。 */
    budgetBalanced: 4096,
    /** deep 档在没有输出预算可换算时的 thinking budget，token。 */
    budgetDeep: 8192,
    /** 按比例换算后的 thinking budget 下限，token。 */
    budgetMin: 1024,
    /** 非 deep 档按比例换算后的 thinking budget 上限，token。 */
    budgetMax: 8192,
    /** deep 档按比例换算后的 thinking budget 上限，token。 */
    budgetMaxDeep: 12_000,
    /** 非 ultra 档相对 maxOutputTokens 的预算系数基线，再乘各档系数。 */
    budgetRatio: 0.35,
    /** fast 档在基线之上的预算系数。 */
    fastMultiplier: 0.5,
    /** deep 档在基线之上的预算系数。 */
    deepMultiplier: 1.5,
    /** ultra 档没有显式输出预算时的 thinking budget 下限，token。 */
    ultraFloor: 16_000,
    /** ultra 档 thinking budget 的硬上限，token。 */
    ultraCeil: 24_000,
    /** ultra 档相对 maxOutputTokens 的预算系数。 */
    ultraRatio: 0.6,
  }),
  /** 请求输入的保守估算。 */
  estimate: Object.freeze({
    /** 每张图片按多少 token 计：主流供应商把图片缩到一两千 token 以内，取上沿；base64 字节数与真实开销无关。 */
    imageTokens: 2_000,
  }),
  /** 瞬时故障重试。 */
  retry: Object.freeze({
    /** 第一次重试的退避基数，毫秒；之后按指数翻倍。 */
    initialDelayMs: 2_000,
    /** 单次退避的上限，毫秒。 */
    maxDelayMs: 30_000,
    /** 重试提示里带上的原始错误文字最多几个字符。 */
    messageChars: 180,
  }),
  /** 产品的连接探测。 */
  profiles: Object.freeze({
    /** 一次连接探测的硬超时，毫秒。 */
    connectionProbeTimeoutMs: 20_000,
  }),
  /** 出错时带进文案的服务端正文长度。 */
  errors: Object.freeze({
    /** Velar embedding 失败时带进错误文案的服务端正文最多几个字符。 */
    velarEmbeddingSummaryChars: 200,
  }),
})
