import type { CapabilityScopeId } from './tool'

// ─── 环境回合上下文（Environment Turn Context）────────────────────────────────
//
// 一套协议、一个会话级 cursor、两个投递点：
// - Pre-send：renderer peek → composer chips 可审 → 冻结进 user 消息 textBlocks + receipt。
// - Mid-run：agent turn 开始时 peek → history note 追加，立即提交 cursor。
// 可见 source 到达模型恰好一次；rendererVisible=false 的 source 跳过 pre-send，只在 mid-run 投递。

export type TurnContextSourceId = string

/** 摘要不足时可用哪个现有工具核实当前事实；argsHint 只能由事件自身字段构造。 */
export interface TurnContextInspectHint {
  tool: string
  argsHint?: Record<string, unknown>
}

export interface TurnContextDelta {
  /** 全局唯一：`${sourceId}#${seq}`。 */
  id: string
  sourceId: TurnContextSourceId
  /** source 内单调递增；source 内排序只信 seq。 */
  seq: number
  occurredAt: number
  /** composer/气泡 chip 短标签。 */
  label: string
  /** 冻结进 textBlocks 的最终文本；main 侧一次性格式化，冻结后不得重排版。 */
  summaryText: string
  inspect?: TurnContextInspectHint
}

/** 稳定态锚点；只在重发条件命中时随消息附加，不做成可删 chip。 */
export interface TurnContextAnchor {
  sourceId: TurnContextSourceId
  key: string
  text: string
}

export interface TurnContextSourcePeekInput {
  sessionId: string
  /** 上次已消费到的 seq；generation 不匹配时忽略此值。 */
  afterSeq: number
  /** 上次 cursor 的 generation；null 表示首次。 */
  generation: Nullable<string>
}

export interface TurnContextSourcePeekResult {
  /** source 实例代次（进程启动随机 id）；不匹配时消费方不回放旧 delta，只取 anchors。 */
  generation: string
  headSeq: number
  tailSeq: number
  /** ring buffer 已丢弃的边界：cursor 落在其之前说明有缺口，需附省略行并推进到 tailSeq。 */
  droppedBeforeSeq?: number
  deltas: TurnContextDelta[]
  anchors: TurnContextAnchor[]
}

/**
 * 环境信号源统一契约。
 *
 * 实现约束（护栏，靠单测证明）：
 * - peekCached 同步返回、纯内存，禁止任何 IO / 系统调用 / 模型调用；
 * - 构造函数只接收已有 Store/Cache，不接收具体能力运行时。
 */
export interface TurnContextDeltaSource {
  id: TurnContextSourceId
  scopes: readonly CapabilityScopeId[]
  /** 为 false 时只参与模型 mid-run 投递，不进入 renderer 的 composer chip 快照。 */
  rendererVisible?: boolean
  peekCached(input: TurnContextSourcePeekInput): TurnContextSourcePeekResult
}

export interface TurnContextSourceCursor {
  generation: string
  seq: number
}

export type TurnContextCursorVector = Partial<Record<TurnContextSourceId, TurnContextSourceCursor>>

/**
 * 发送时冻结在 user 消息上的回执；main 在 chat.send.accepted 后据此整向量幂等提交 cursor。
 * observedThrough 推进到本次 peek 的 tailSeq——含被用户删除的 delta，删掉的不会下轮重新出现。
 */
export interface ContextDeltaReceipt {
  observedThrough: TurnContextCursorVector
  includedDeltaIds: string[]
  dismissedDeltaIds: string[]
  /** `${space}|${contextViewId ?? 'raw'}|${anchorsHash}`；变化即重发 anchors。 */
  anchorGeneration: string
  /** anchors 最后一次实际附加的消息 id；距今 ≥ 心跳轮数时强制重发（防旧轮被摘要化）。 */
  anchorCarrierMessageId: string
}

/** 挂在 ChatMessage 上的环境上下文元数据：receipt 供协议，chips 供气泡展示。 */
export interface ChatMessageTurnContext {
  receipt: ContextDeltaReceipt
  chips: Array<{ sourceId: TurnContextSourceId; label: string }>
}

/** pre-send peek 请求（renderer → main，纯内存同步聚合）。 */
export interface ChatTurnContextPeekRequest {
  sessionId: string
  scope: CapabilityScopeId
}

/** delta 写入后的变更推送（main → renderer，写入侧防抖），驱动 composer chips 实时刷新。 */
export interface ChatTurnContextChangedEvent {
  sessionId: string
}

/** fan-in 聚合后经 IPC 给 renderer 的快照；renderer 据此渲染 chips 并在发送时冻结。 */
export interface TurnContextPeekSnapshot {
  sessionId: string
  scope: CapabilityScopeId
  capturedAt: number
  /** 各 source 本次 peek 的 {generation, tailSeq}，即 receipt.observedThrough 的基底。 */
  observedThrough: TurnContextCursorVector
  /** 已按 occurredAt/sourceId/seq 确定性排序、已应用 cap；renderer 只做 dismissed 过滤不得重排。 */
  deltas: TurnContextDelta[]
  anchors: TurnContextAnchor[]
  /** anchors 内容哈希；renderer 与 space/viewId 组合成 anchorGeneration。 */
  anchorsHash: string
  /** 溢出/缺口提示行（已格式化），冻结时置于 delta 文本之前。 */
  overflowNotes: string[]
}
