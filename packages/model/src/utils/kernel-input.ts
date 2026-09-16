import { isNonBlankString, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ModelWireLimits } from '../contract/constants.js'
import type { ChatProviderId } from '../types/model'

/** wire 入参不合格时统一这一个形状的错误，`detail` 说清哪一条判据没过。 */
function invalidCapabilityInput(detail: string): AppError {
  return new AppError('VALIDATION', `模型能力的入参不合法：${detail}`)
}

/**
 * 判据（§5.3b ④安全门）——wire 面唯一的入参解析点，**只认恰好一个 `provider` 键**。
 *
 * 多余的键一律拒而不是忽略：这条通道对外可调用，宽进等于允许"多传一个字段就能改行为"，
 * 且日后给 `supports_provider` 加轴时，旧客户端的错拼字段会静默被当默认值。长度上限挡的是
 * 拿 id 当载荷灌进来。四条判据各自给独立诊断（§2.7）——原先四条共用一句话，等于没有诊断。
 */
export function parseModelCapabilityProviderInput(input: unknown): ChatProviderId {
  if (!isPlainObject(input)) throw invalidCapabilityInput('入参必须是一个对象')

  const keys = Object.keys(input)
  if (keys.length !== 1) {
    throw invalidCapabilityInput(`只认恰好一个 "provider" 键，实际收到 [${keys.join(', ')}]`)
  }
  if (!isNonBlankString(input.provider)) {
    throw invalidCapabilityInput('"provider" 必须是非空字符串')
  }
  if (input.provider.length > ModelWireLimits.providerIdChars) {
    throw invalidCapabilityInput(
      `"provider" 超过了 ${ModelWireLimits.providerIdChars} 个字符的上限`
    )
  }

  return input.provider as ChatProviderId
}
