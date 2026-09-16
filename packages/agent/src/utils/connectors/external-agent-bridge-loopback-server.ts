// ExternalAgentBridgeLoopbackServer 用到的纯函数（不碰实例状态）。
import { isString } from '@velaros-ai/core'

/** 判断握手来源是不是受信外部客户端的合法 origin（只认 32 位客户端 id）。 */
export function isExternalAgentBridgeExtensionOrigin(origin: unknown): origin is string {
  return isString(origin) && /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)
}
