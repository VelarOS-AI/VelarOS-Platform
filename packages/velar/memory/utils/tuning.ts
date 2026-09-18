/**
 * 包内可调参数：超时、缓冲、保留条数、缺省条数、阈值。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 *
 * 常量按四处放（ADR 0007）：
 * - 对外承诺的（后端 id、作用域身份、证据的上限与类别）在 `contract/constants.ts`，改了等于改契约；
 * - 可调的都在这里，按用途分组、每项一句说明；实现与 utils 里不再散写数字缺省值，门禁核对；
 * - 某个类里固定用的文案、模式、名单写成那个类的 `private static readonly`；
 * - 规则本身的数据（谓词名单、概念类型映射、跳过的目录）跟着规则写在各自的 utils 文件里；算法与格式里的数字（哈希取几位、schema 版本号）就地写。
 */

/** 记忆包的可调参数，按用途分组。 */
export const MemoryTuning = Object.freeze({
  /** 证据采集桥：宿主事件规整成证据、串行入库、即时整理。 */
  capture: Object.freeze({
    /** 采集一批后立即整理多少条证据；后端没有整理管线时忽略。 */
    immediateDreamBatch: 25,
    /** 由正文推出的标题最多留多少字。 */
    titleMaxChars: 72,
    /** 观察证据里「对谁做的」（路径、目标）最多留多少字。 */
    targetMaxChars: 240,
    /** 观察证据里执行阶段名最多留多少字。 */
    phaseMaxChars: 80,
    /** 观察证据里按键序列这类参数摘要最多留多少字。 */
    keysMaxChars: 100,
  }),
  /** 回合召回：后台召回、增量账本注入、可等待召回。 */
  recall: Object.freeze({
    /** 用户消息短于多少字就不触发召回（太短的问句召回噪声大于收益）。 */
    minQueryChars: 4,
    /** 拿去召回的查询文本最多截到多少字。 */
    queryMaxChars: 600,
    /** 一次向后端要多少条候选，再按去重与可见性筛。 */
    candidateLimit: 12,
    /** 每个回合最多往模型上下文里注入多少条记忆。 */
    maxInjectPerTurn: 3,
    /** 每个会话的增量账本最多留多少条，超出从最早的挤掉。 */
    ledgerMaxEntries: 16,
    /** 记住「哪些会话注入过哪些条目」的会话数上限，超出按最早使用挤掉。 */
    injectedSessionsMax: 128,
    /** 可等待召回（外部引擎走这条）的硬预算，毫秒；到点就返回已有结果。 */
    awaitableTimeoutMs: 2_000,
    /** 在途召回看门狗，毫秒；超过这个时长的在途标记按失效清掉，避免闩死。 */
    inFlightWatchdogMs: 30_000,
    /** 注入摘要里标题最多留多少字。 */
    summaryTitleChars: 48,
    /** 注入摘要里正文最多留多少字。 */
    summaryBodyChars: 200,
    /** 注入摘要里来源标注最多留多少字。 */
    summarySourceChars: 160,
    /** 注入摘要里类别标签最多留多少字。 */
    summaryLabelChars: 16,
  }),
  /** 后台整理：空闲调度与单次整理批量。 */
  dream: Object.freeze({
    /** 空闲调度器多久醒一次看要不要整理，毫秒。 */
    tickIntervalMs: 60_000,
    /** 系统连续空闲多少秒才认为适合后台整理。 */
    idleThresholdSeconds: 300,
    /** 空闲整理一次处理多少条证据（机器闲着，可以多做些）。 */
    idleBatchSize: 400,
    /** 显式触发整理时没给批量的缺省条数。 */
    defaultBatchSize: 200,
  }),
  /** 文件权威层：markdown 条目与索引。 */
  files: Object.freeze({
    /** 一次召回最多读多少份条目全文；再多就只按索引行打分，避免一次召回读几百个文件。 */
    maxFullTextReadsPerRecall: 24,
    /** 召回没给 limit 时返回多少条。 */
    defaultRecallLimit: 10,
    /** 召回 limit 的上限，超出按这个钳。 */
    maxRecallLimit: 100,
    /** 索引行里的摘要最多留多少字。 */
    descriptionMaxChars: 400,
    /** 由标题生成的文件名（slug）最多留多少字。 */
    slugMaxChars: 60,
    /** 同名条目最多试多少个后缀找空位，再多就判失败而不是无限找。 */
    pathAllocationAttempts: 1_000,
    /** 从正文里取首行当摘要时最多留多少字。 */
    firstLineMaxChars: 120,
    /** 带内容级过滤时最多扫多少份全文：过滤发生在全文上，小窗口会让偏好被最近的会话条目挤光。 */
    maxFilteredFullTextScansPerRecall: 200,
    /** 越界路径的诊断去重表上限：同一个坏索引每次召回都会再撞一次，日志不该跟着涨。 */
    reportedOutOfBoundsPaths: 200,
    /** 悬空符号链接最多追几跳；超过（多半是链接成环）就不再追。 */
    danglingLinkHops: 40,
  }),
  /** 叠加编排：权威层 + 派生索引。 */
  layered: Object.freeze({
    /** 向派生索引多要几倍候选，回权威层取全文后再筛到要的条数。 */
    derivedCandidateFactor: 3,
    /** 向派生索引一次最多要多少条候选。 */
    maxDerivedCandidates: 200,
    /** 召回没给 limit 时返回多少条。 */
    defaultRecallLimit: 10,
  }),
  /** 向量派生索引：嵌入与穷举余弦检索。 */
  vector: Object.freeze({
    /** 一次向嵌入端口送多少条文本。 */
    embedBatchSize: 64,
    /** 召回没给 limit 时返回多少条。 */
    defaultRecallLimit: 10,
    /** 召回 limit 的上限，超出按这个钳。 */
    maxRecallLimit: 200,
    /** 余弦相似度低于这个值的命中直接丢掉。 */
    minimumSimilarity: 0.2,
    /** 送去嵌入的文本最多截到多少字。 */
    maxEmbeddedTextChars: 4_000,
  }),
  /** 记忆树 v1：SQLite 仓、语义候选抽取、证据清洗。 */
  tree: Object.freeze({
    /** 召回没给 limit 时返回多少条。 */
    recallDefaultLimit: 12,
    /** 召回 limit 的上限，超出按这个钳。 */
    recallMaxLimit: 100,
    /** 一次查询最多拆出多少个 LIKE 词，再多就只用前面的。 */
    likeTermsMax: 12,
    /** 投影树状态时每层最多取多少个概念。 */
    topConcepts: 12,
    /** 一条证据最多抽多少个语义候选。 */
    semanticCandidates: 8,
    /** 单个语义子句最多留多少字。 */
    semanticClauseChars: 420,
    /** 元数据里单个字符串值最多留多少字。 */
    metadataStringChars: 2_000,
    /** 元数据里单个数组最多留多少项。 */
    metadataArrayItems: 100,
    /** 元数据最多嵌套多少层，再深就丢弃。 */
    metadataDepth: 5,
  }),
  /** 记忆树 v2：加密树后端（包内子系统，暂未接线）。 */
  treeV2: Object.freeze({
    /** 召回没给 limit 时返回多少条。 */
    recallDefaultLimit: 3,
    /** 召回 limit 的上限，超出按这个钳。 */
    recallMaxLimit: 12,
    /** 一条召回结果最多带多少个路径节点。 */
    maxPathNodes: 16,
    /** 每多少代索引写一次检查点。 */
    checkpointInterval: 64,
  }),
} as const)
