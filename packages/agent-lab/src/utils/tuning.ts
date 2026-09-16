/** 包内可调参数：只放数字，每项一句说明、每项都有人用。对外承诺的上限与缺省阈值在 contract/constants.ts。 */
export const AgentLabTuning = Object.freeze({
  /** 轮询驱动（impl/LabDrivers.ts）。 */
  driver: Object.freeze({
    /** 两次问执行体状态之间隔多少毫秒。 */
    pollMs: 2_500,
    /** 连续几次看到「不在跑」才算这一段收敛；一次抖动不算。 */
    settlePolls: 2,
    /** 段预算没给墙钟上限时，最多等多少毫秒。 */
    defaultWallClockMs: 240_000,
  }),
  /** 统计（utils/measure/statistics.ts）。 */
  statistics: Object.freeze({
    /** 簇 bootstrap 重抽多少次；次数越多区间越稳，也越慢。 */
    bootstrapSamples: 10_000,
  }),
  /** 内置探测器里与阈值无关的判定参数（utils/measure/detectors.ts）。 */
  detectors: Object.freeze({
    /** assistant 文本超过多少字符才去看它是不是泄漏了完整制品协议；短文本里出现闭合标签是正常引用。 */
    protocolLeakMinChars: 800,
    /** 上下文占用百分比超过多少算异常（正常最多 100，留一段余量给估算误差）。 */
    contextPercentCeiling: 150,
    /** 上下文估算超过模型窗口多少倍算异常。 */
    contextOverrunRatio: 1.2,
  }),
  /** 真实任务审计（utils/measure/workload.ts）。 */
  workload: Object.freeze({
    /** 同一个工具错误连续出现几次才记成重试打转；一两次是正常重试。 */
    repeatedToolErrorRun: 3,
  }),
  /** 自适应战役的选批打分（utils/measure/campaign.ts）。 */
  campaign: Object.freeze({
    /** 一条修完的失败要几个证明任务通过才关；缺省档。 */
    proofTasksDefault: 2,
    /** 模型与运行时这类容易反复的根因，要几个证明任务通过才关。 */
    proofTasksVolatile: 3,
    /** 证明任务的加分：它必须排在最前面。 */
    provingScore: 10_000,
    /** 上次跑失败的用例加多少分。 */
    failedScore: 1_000,
    /** 上次判不了的用例加多少分。 */
    voidScore: 250,
    /** 还没有当前证据的用例加多少分。 */
    freshScore: 500,
    /** 每覆盖到一个本批还没覆盖的维度加多少分。 */
    novelDimensionScore: 40,
    /** 日常权重每一点折算多少分。 */
    dailyWeightScore: 10,
    /** 边界与失败恢复这两条路径额外加多少分。 */
    hardPathScore: 20,
  }),
})
