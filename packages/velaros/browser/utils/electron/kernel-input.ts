/** 内核能力的入参解析：形状不对就给一条带错误码的失败回执，不猜。 */

/** 能力边界的入参一律拒绝而非纠正：这里收到的形状不对，意味着调用方与本版本 ABI 已不同步。 */
import { isBlank, isEmpty, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 拼一条「内核能力的入参不合法」的报错。 */
export function invalidCapabilityInput(): AppError {
  return new AppError('VALIDATION', '浏览器能力的入参形状不对。')
}

/**
 * 会话入参解析：**只认恰好一个 `sessionId` 字段**。
 *
 * 严到这个程度是刻意的——它是 kernel 能力面（进程外调用方也能打进来）：
 *  - 多余字段 = 调用方以为自己传了参数而实际被丢弃，静默降级最难查；
 *  - 首尾空白不 trim 而是拒绝：会话 id 是索引键，静默归一会让两个「不同」的 id 落到同一会话；
 *  - 512 上限挡的是拿超长字符串当键的内存放大。
 */
export function parseSessionInput(input: unknown): string {
  if (!isPlainObject(input)) throw invalidCapabilityInput()
  const sessionId = input.sessionId
  if (
    Object.keys(input).length !== 1
    || !isString(sessionId)
    || isBlank(sessionId)
    || sessionId !== sessionId.trim()
    || sessionId.length > 512
  ) {
    throw invalidCapabilityInput()
  }
  return sessionId
}

/** 校验一个本该为空的入参；带了东西就报错。 */
export function parseEmptyInput(input: unknown): void {
  if (!isPlainObject(input) || !isEmpty(Object.keys(input))) {
    throw invalidCapabilityInput()
  }
}
