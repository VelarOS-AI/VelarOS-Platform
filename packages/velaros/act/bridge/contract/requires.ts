import type { ModelDriverLimits, ModelInputEstimate, ModelTurnRequest } from '@velaros-ai/kernel'

import type { ExternalModelRequest } from '../types.js'

/** 路由与传输由产品宿主提供，协议解析与运行继续归 Platform。 */
export interface ExternalModelDriverOptions {
  /** 当前网页模型通道身份。 */
  readonly id: string
  /** 已协商的模型容量。 */
  readonly limits: ModelDriverLimits
  /** 为每次请求和租约生成不可复用身份。 */
  createId(): string
  /** 发送一个完整冻结请求，不能在此选择或压缩材料。 */
  send(request: ExternalModelRequest): Promise<void>
  /** 撤销具体请求，晚到响应不得恢复租约。 */
  cancel(requestId: string, lease: string): Promise<void>
  /** 输入估算采用与发送一致的编码；未提供时使用保守字节估算。 */
  estimate?(request: ModelTurnRequest): Promise<ModelInputEstimate>
  /** 单请求等待上限，默认使用桥合同的限制。 */
  readonly timeoutMs?: number
}
