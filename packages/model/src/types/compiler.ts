import type { ModelInputEstimate, ModelTurnRequest } from '@velaros-ai/kernel'
/** 可落盘的请求原始值，特殊值用显式类型标签保存。 */
export type ProviderRequestAuditValue = Nullable<boolean | number | string | ProviderRequestAuditValue[] | { [key:string]:ProviderRequestAuditValue }>
/** 请求内容指纹，与模型可见消息和响应约束绑定。 */
export interface ProviderRequestFingerprint {
 readonly id:string
 readonly systemHash:string
 readonly messageHash:string
 readonly prefixHash:string
 readonly responseFormatHash?:string
}
/** 实际模型请求的可重建审计快照。 */
export interface ProviderRequestSnapshot {
 readonly schemaVersion:2
 readonly model:string
 readonly system:string
 readonly messages:ProviderRequestAuditValue
 readonly tools:readonly []
 readonly responseFormat?:ProviderRequestAuditValue
 readonly outputTokens:number
 readonly requestFingerprint:ProviderRequestFingerprint
}
/** 已物化视图经编译后的最终请求及发送准入。 */
export interface CompiledModelRequest {
 readonly request:ModelTurnRequest
 readonly estimate:ModelInputEstimate
 readonly okToSend:boolean
 readonly providerRequest:ProviderRequestSnapshot
}
