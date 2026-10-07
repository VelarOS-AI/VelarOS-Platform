import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'

import { ScriptActBridge } from '../contract/constants.js'
import type { ScriptActBridgeEnvelope } from '../types.js'

/** 本地 wire 消息身份校验；领域 payload 在宿主受理边界进一步核对。 */
export interface BridgeProtocolApi {
  /** 接收完整 JSON 消息并核验严格信封。 */
  parse(value: unknown): ScriptActBridgeEnvelope
}

class BridgeProtocol implements BridgeProtocolApi {
  private readonly identity = z.string().min(1).max(128)
  private readonly envelope = z.strictObject({
    service: z.literal(ScriptActBridge.service),
    version: z.literal(ScriptActBridge.version),
    id: this.identity,
    type: this.identity,
    hostId: this.identity.optional(),
    epoch: this.identity.optional(),
    replyTo: this.identity.optional(),
    payload: z.record(z.string(), z.unknown()),
  })

  public parse(value: unknown): ScriptActBridgeEnvelope {
    const parsed = this.envelope.safeParse(value)
    if (!parsed.success) throw new AppError('PROTOCOL', `桥消息字段无效：${parsed.error.message}`)
    return parsed.data
  }
}

/** 完整 wire 信封的唯一校验器。 */
export const scriptActBridgeProtocol: BridgeProtocolApi = new BridgeProtocol()
