import { isEmpty, isPlainObject } from '@velaros-ai/core'

/**
 * 内核 callable 的 health 入参校验：这条调用不收任何参数，所以只接受空对象。
 * 多给字段一律当成调用点用错了协议，抛错拒绝，而不是悄悄忽略。
 */
export function parseEmptyInput(input: unknown): void {
  if (!isPlainObject(input) || !isEmpty(Object.keys(input))) {
    throw new Error('health 这个调用不收任何参数：入参只能是空对象 {}，多给字段说明调用点用错了协议。')
  }
}
