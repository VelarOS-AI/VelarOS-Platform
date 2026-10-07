import type { ModelImage, ModelTurnRequest } from '@velaros-ai/kernel'

/** 一个网页模型请求；会话、设备和进程身份由宿主信封提供。 */
export interface ExternalModelRequest {
  /** 请求唯一身份。 */
  readonly requestId: string
  /** 本次派发的不可复用租约。 */
  readonly lease: string
  /** Runtime 已封存的原始请求。 */
  readonly request: ModelTurnRequest
  /** 与估算相同的中立文字编码，网页直接交付。 */
  readonly prompt: string
  /** 与中立消息顺序一致的真实图像；通过供应商文件口上传。 */
  readonly images: readonly ModelImage[]
}

/** 完整响应原子交付；预览不属于模型接收链。 */
export type ExternalModelReply = {
  readonly requestId: string
  readonly lease: string
} & (
  | {
      readonly type: 'finished'
      readonly text: string
      readonly reason: 'stop' | 'length'
      /** 真实供应商结束帧的类型；连接 EOF 不构成结束事实。 */
      readonly evidence: string
    }
  | { readonly type: 'failed'; readonly code: string; readonly message: string }
)

/** 本地服务的便携消息信封；payload 按 type 在产品受理边界核验。 */
export interface ScriptActBridgeEnvelope {
  readonly service: 'velaros-scriptact-bridge'
  readonly version: 1
  readonly id: string
  readonly type: string
  readonly hostId?: string
  readonly epoch?: string
  readonly replyTo?: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** 单个活动网页请求的等待状态。 */
export interface ExternalModelPending {
  readonly lease: string
  readonly resolve: (reply: ExternalModelReply) => void
  readonly reject: (error: unknown) => void
}
