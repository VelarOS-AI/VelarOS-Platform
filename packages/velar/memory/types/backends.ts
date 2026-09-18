/** 后端编排与召回过滤用的包内工作类型。 */

/** 召回过滤时调用方额外知道的读数：语义通道只有召回条目，词法通道还知道确切类别。 */
export interface MemoryRecallFilterHints {
  /**
   * 这一条的确切证据类别（权威层读到全文时知道）。
   *
   * 缺席时按 `conceptType` 反推：类别到概念类型不是一一对应（`fact` 与 `entity` 都落 `entity`），
   * 反推只能宽一格。语义通道只有召回条目，宽一格也远好过完全不过滤。
   */
  readonly category?: string
}

/** 派生层出问题时的诊断事件。**永远只是诊断**——没有一条会改变权威层的返回值。 */
export interface MemoryDerivedIndexFailure {
  /** 哪个派生索引出的问题。 */
  readonly backendId: string
  /** 在哪一步出的问题。 */
  readonly stage: 'index' | 'recall' | 'prune' | 'archive' | 'rebuild'
  /** 原始错误，交给宿主诊断面展示。 */
  readonly error: unknown
}
