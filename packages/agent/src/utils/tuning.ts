/** 运行服务的内部默认值。 */
export const AgentTuning = Object.freeze({
  /** 持久事件默认分页条数。 */
  eventPage: 100,
  /** 限速错误没带等待时长时，等这么久再预留。 */
  rateRetryMs: 60_000,
})
/** 上下文规划的缺省值；宿主经 frames.policy 覆盖前四项。 */
export const ContextPlanTuning = Object.freeze({
  /** 无可延续的可发送前缀时，剩余不足这么多轮就封段；也是严重预警阈值。 */
  foldTurns: 2,
  /** 无可延续的可发送前缀时，剩余不足这么多轮且处在章节边界就封段。 */
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
  /** 已找到可发送的恢复投影后，最多本地试算几次较大正文。 */
  projectionAttempts: 4,
  /** 本次运行连续没有进展这么多步，ContextStatus 给出停滞提示。 */
  stallNotice: 3,
  /** 连续没有进展这么多步，本帧尾加反思说明。 */
  stallReflect: 6,
  /** 连续没有进展这么多步，暂停运行等用户。 */
  stallPause: 9,
  /** 一段里缺页至少这么多次、且平均不到 faultTurns 轮一次，按结构性超载处理。 */
  faultCount: 3,
  /** 缺页频率的判断：每这么多轮至少一次。 */
  faultTurns: 4,
})
