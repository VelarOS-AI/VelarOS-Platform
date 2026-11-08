import type { ModelInputEstimate, ModelTurnRequest } from '@velaros-ai/kernel'
/** 指纹计算的稳定编码值；仅用于当前编译，不作为持久请求正文。 */
export type ProviderFingerprintValue = Nullable<
  | boolean
  | number
  | string
  | ProviderFingerprintValue[]
  | { [key: string]: ProviderFingerprintValue }
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
/** 与完整 live 请求分离的有界审计元数据，不保存指令、消息、工具定义或图片。 */
export interface ProviderRequestAudit {
  readonly schemaVersion: 3
  readonly model: string
  readonly modelTruncated: boolean
  readonly inputTokens: number
  readonly precision: 'exact' | 'estimate'
  readonly basis: string
  readonly basisTruncated: boolean
  readonly outputTokens: number
  readonly messageCount: number
  readonly toolCount: number
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
  readonly requestAudit: ProviderRequestAudit
}
