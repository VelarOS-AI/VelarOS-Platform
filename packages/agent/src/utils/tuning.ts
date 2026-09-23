/** 运行服务的内部默认值。 */
export const AgentTuning = Object.freeze({
  /** 持久事件默认分页条数。 */
  eventPage: 100,
})
/** 上下文规划的缺省值；宿主经 frames.policy 覆盖前四项。 */
export const ContextPlanTuning = Object.freeze({
  /** 剩余不足这么多轮就封段。 */
  foldTurns: 2,
  /** 剩余不足这么多轮、又处在章节边界时封段。 */
  boundaryTurns: 8,
  /** 封段后剩余仍不足这么多轮，算结构性超载。 */
  minTurns: 4,
  /** 工作窗口上限，token；与模型输入上限取较小值。 */
  windowTokens: 200_000,
  /** 供应商超窗拒绝与完成检查的修复次数。 */
  recoveryAttempts: 2,
  /** 估算校准取最近多少次实测。 */
  calibrationSamples: 16,
  /** 校准比值上浮的余量，宁可高估。 */
  calibrationMargin: 1.1,
  /** 每轮增长取最近多少个样本。 */
  growthSamples: 8,
  /** 还没有增长样本时，每轮增长按窗口的这个比例估计。 */
  growthSeed: 0.04,
  /** 字符密度取最近多少帧。 */
  densitySamples: 8,
})
