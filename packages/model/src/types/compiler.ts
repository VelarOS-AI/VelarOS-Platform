import type { ModelInputEstimate, ModelTurnRequest } from '@velaros-ai/kernel'
/** 可落盘的请求原始值，特殊值用显式类型标签保存。 */
export type ProviderRequestAuditValue = Nullable<
  | boolean
  | number
  | string
  | ProviderRequestAuditValue[]
  | { [key: string]: ProviderRequestAuditValue }
>
/** 请求内容指纹，与模型可见消息和响应约束绑定。 */
export interface ProviderRequestFingerprint {
  readonly id: string
  readonly systemHash: string
  readonly messageHash: string
  readonly prefixHash: string
  readonly responseFormatHash?: string
  readonly toolsHash?: string
}
/** 实际模型请求的可重建审计快照。 */
export interface ProviderRequestSnapshot {
  readonly schemaVersion: 2
  readonly model: string
  readonly system: string
  readonly messages: ProviderRequestAuditValue
  readonly tools: readonly ProviderRequestAuditValue[]
  readonly responseFormat?: ProviderRequestAuditValue
  readonly outputTokens: number
  readonly requestFingerprint: ProviderRequestFingerprint
}
/** 用供应商实测用量得到的估算校准；图片和不透明状态部分不参与。 */
export interface ModelEstimateCalibration {
  /** 文本增长与原始估算之比，取 (0, 1]；1 等于不缩小估算。 */
  readonly textRatio: number
  /** 实测样本支持的固定输入开销，已包含安全余量；缺省为零。 */
  readonly overheadTokens?: number
}
/** 已物化视图经编译后的最终请求及发送准入。 */
export interface CompiledModelRequest {
  readonly request: ModelTurnRequest
  /** 发送准入用的估算；给了校准时是校准后的数。 */
  readonly estimate: ModelInputEstimate
  /** 原始估算分开记录文本、图片和不透明状态；调用方用无图片实测校准文本。 */
  readonly measured: { readonly text: number; readonly images: number; readonly opaque?: number }
  readonly okToSend: boolean
  readonly providerRequest: ProviderRequestSnapshot
}
