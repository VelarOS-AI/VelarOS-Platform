/** 活动账本与差量计算的内部默认值。 */
export const ContextTuning = Object.freeze({
  /** 每本活动账本默认保留条数。 */
  ledgerItems: 100,
  /** 默认保留会话账本数量。 */
  sessions: 64,
  /** 单次行差量计算的编辑步数上限。 */
  diffEdits: 128,
  /** 小块保持原文粒度，局部编辑之后按内容重新对齐。 */
  bodyChunkMinBytes: 2_048,
  /** 限制单块解压与损坏输入的内存占用。 */
  bodyChunkMaxBytes: 16_384,
  /** 平均约 4KB 触发一次内容边界。 */
  bodyChunkBoundaryMask: 4_095,
  /** 采用低压缩级别，避免交互写入消耗过多 CPU。 */
  bodyCompressionLevel: 3,
})
