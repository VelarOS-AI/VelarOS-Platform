import { AppError } from '@velaros-ai/core/error'

import { ScriptActBridge } from '../contract/constants.js'
import type { ScriptActBridgeEnvelope } from '../types.js'

/** 本地 wire 消息身份校验；领域 payload 在宿主受理边界进一步核对。 */
export interface BridgeProtocolApi {
  /** 接收完整 JSON 消息并核验严格信封。 */
  parse(value: unknown): ScriptActBridgeEnvelope
}

class BridgeProtocol implements BridgeProtocolApi {
  public parse(value: unknown): ScriptActBridgeEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AppError('PROTOCOL', '桥消息必须是 JSON 对象')
    const message = value as Record<string, unknown>
    const allowed = ['service', 'version', 'id', 'type', 'hostId', 'epoch', 'replyTo', 'payload']
    if (
      Object.keys(message).some((key) => !allowed.includes(key)) ||
      message.service !== ScriptActBridge.service ||
      message.version !== ScriptActBridge.version
    )
      throw new AppError('PROTOCOL', '桥消息合同不兼容')
    for (const key of ['id', 'type'])
      if (typeof message[key] !== 'string' || !message[key] || message[key].length > 128)
        throw new AppError('PROTOCOL', `桥消息 ${key} 无效`)
    for (const key of ['hostId', 'epoch', 'replyTo'])
      if (
        message[key] !== undefined &&
        (typeof message[key] !== 'string' || !message[key] || message[key].length > 128)
      )
        throw new AppError('PROTOCOL', `桥消息 ${key} 无效`)
    if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload))
      throw new AppError('PROTOCOL', '桥消息 payload 必须是对象')
    return message as unknown as ScriptActBridgeEnvelope
  }
}

/** 完整 wire 信封的唯一校验器。 */
export const scriptActBridgeProtocol: BridgeProtocolApi = new BridgeProtocol()
