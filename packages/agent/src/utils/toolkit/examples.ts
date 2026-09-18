/**
 * 工具调用示例：把一条示例编成模型实际会收到的那串 JSON，把一组示例渲染成「示例：」分节的条目。
 * 示例就在工具规格上（`examples`），定义工具时渲染进说明、按工具自己的 schema 校验，不另设进程级登记表。
 */

import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { NonEmptyToolContractList } from '../../types/toolkit.js'

/**
 * 把一条示例编成模型实际会收到的那串 JSON。循环引用、BigInt 这类编不出来的值，以及
 * undefined、函数、symbol 这类会被整个丢掉的值，都在这里抛 `VALIDATION`——示例原样进提示词，
 * 坏示例必须在装配期炸，不能等模型照着抄才发现。
 */
export function serializeToolExampleInput(value: unknown): string {
  try {
    // 模型示例与真实 JSON 调用共用编码规则：正确转义键和值，缺省字段保持省略。
    const serialized = JSON.stringify(value)
    if (isString(serialized)) return serialized
  } catch (cause) {
    throw new AppError(
      'VALIDATION',
      '工具调用示例必须能被 JSON.stringify 序列化：这份示例里出现了循环引用或 BigInt 这类 JSON 编不出来的值。示例会原样进模型提示词，请改成纯 JSON 值再登记。',
      cause
    )
  }
  throw new AppError(
    'VALIDATION',
    '工具调用示例序列化后没有 JSON 表示：示例本身是 undefined、函数或 symbol 这类 JSON.stringify 会直接丢掉的值。请把它换成一个参数对象再登记。'
  )
}

/** 把一组示例渲染成「示例：」分节的条目，每条一句「调用参数示例：<JSON>。」。 */
export function renderToolExampleInputs(
  examples: NonEmptyToolContractList<Record<string, unknown>>
): NonEmptyToolContractList {
  const [firstExample, ...remainingExamples] = examples
  const rendered: [string, ...string[]] = [
    `调用参数示例：${serializeToolExampleInput(firstExample)}。`,
    ...remainingExamples.map((example) => `调用参数示例：${serializeToolExampleInput(example)}。`),
  ]
  return rendered
}
