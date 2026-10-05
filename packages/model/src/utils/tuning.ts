/** 内部供应商协议上限，不是宿主可配置的产品参数，也不从包入口导出。 */
export const ModelPromptCacheProtocolLimits = Object.freeze({
  /** 原生 Anthropic Messages 请求的缓存槽上限；显式点与顶层自动缓存共用。 */
  anthropicBreakpoints: 4,
})

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
  /** 思考力度到按数字预算发的型号的 thinking budget。 */
  reasoning: Object.freeze({
    /**
     * 各档的 thinking budget，token：拿不到本次输出上限时用 `fallback`，拿得到就按 `ratio` 换算再钳到 `cap`。
     * 比例与上限逐档递增。
     */
    budgets: Object.freeze({
      /** low 档。 */
      low: Object.freeze({
        /** 拿不到本次输出上限时的预算，token。 */
        fallback: 2048,
        /** 相对输出上限的预算比例。 */
        ratio: 0.175,
        /** 按比例换算后的预算上限，token。 */
        cap: 8192,
      }),
      /** medium 档。 */
      medium: Object.freeze({
        /** 拿不到本次输出上限时的预算，token。 */
        fallback: 4096,
        /** 相对输出上限的预算比例。 */
        ratio: 0.35,
        /** 按比例换算后的预算上限，token。 */
        cap: 8192,
      }),
      /** high 档。 */
      high: Object.freeze({
        /** 拿不到本次输出上限时的预算，token。 */
        fallback: 8192,
        /** 相对输出上限的预算比例。 */
        ratio: 0.525,
        /** 按比例换算后的预算上限，token。 */
        cap: 12_000,
      }),
      /** xhigh 档。 */
      xhigh: Object.freeze({
        /** 拿不到本次输出上限时的预算，token。 */
        fallback: 16_000,
        /** 相对输出上限的预算比例。 */
        ratio: 0.6,
        /** 按比例换算后的预算上限，token。 */
        cap: 16_000,
      }),
      /** max 档。 */
      max: Object.freeze({
        /** 拿不到本次输出上限时的预算，token。 */
        fallback: 24_000,
        /** 相对输出上限的预算比例。 */
        ratio: 0.75,
        /** 按比例换算后的预算上限，token。 */
        cap: 24_000,
      }),
    }),
    /** 按比例换算后的 thinking budget 下限，token。 */
    budgetMin: 1024,
  }),
  /** 请求输入的保守估算。 */
  estimate: Object.freeze({
    /** BPE 文本和同一路由实测附加开销的共同余量。 */
    calibrationMargin: 1.1,
    /** 每个模型驱动保留的最新无图输入样本数量；只存数字。 */
    calibrationSamples: 32,
    /** 每张图片按多少 token 计：主流供应商把图片缩到一两千 token 以内，取上沿；base64 字节数与真实开销无关。 */
    imageTokens: 2_000,
  }),
  /** 流式响应的转发。 */
  stream: Object.freeze({
    /** Responses 单个 SSE 事件的原始字节上限；超限失败，不截成成功终端。 */
    responseEventBytes: 16 * 1024 * 1024,
    /** 一条响应最多转给宿主多少字符的思考摘要；超出的部分不再转发，响应照常接收。 */
    reasoningChars: 200_000,
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
