/** 活动账本与差量计算的内部默认值。 */
export const ContextTuning = Object.freeze({
  /** 每本活动账本默认保留条数。 */
  ledgerItems: 100,
  /** 默认保留会话账本数量。 */
  sessions: 64,
  /** 单次行差量计算的编辑步数上限。 */
  diffEdits: 128,
})
