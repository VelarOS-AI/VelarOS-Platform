/**
 * 宽容入参的原语：可钳制的数量、带缺省说明的可选参数、按专属字段推断 action。工具必须先明确哪些调整保持用户意图：
 *
 *  ① `clampedInt` 只用于可安全收紧的显示/资源预算；源码坐标和精确数量不能静默钳制。钳过的值由执行门写回生效参数、
 *     经工具元数据的 `inputAdjustments` 回显，模型知道系统替它改了什么。
 *  ② `withDefaultNote` 仅用于已声明的安全默认；写入正文、目标引用和确认选择不补默认。
 *  ③ `inferActionFromFields` 仅从足以唯一证明操作的专属字段推断；命中多个就不猜。
 *  ④ 无关附加元数据可 strip；决定操作、目标和正文的合同应 strict，避免忽略显式意图。
 *
 * 注意：transform 会让 `z.toJSONSchema` 的 output 视图抛错——出 schema 一律 `io:'input'`（见 `json-schema.ts`），
 * 新消费方自建转换时必须同样传 `io:'input'`，否则工具退化成零参数兜底（真实事故）。
 */

import { z } from 'zod'

import { isPresent } from '@velaros-ai/core'
import { clampRounded } from '@velaros-ai/core/utils/number'

/** 对允许收紧的资源/显示预算钳制并取整：超界不报错，夹回边界。 */
export function clampedInt(min: number, max: number): z.ZodType<number, number> {
  return z.number().transform((value) => clampRounded(value, min, max))
}

/** 可选参数带缺省：比 zod `.default` 多一层语义——缺省值本身写进 describe 提示。 */
export function withDefaultNote<T extends z.ZodType>(
  schema: T,
  defaultValue: NonNullable<z.output<T>>,
  note: string
): z.ZodType<NonNullable<z.output<T>>> {
  return schema
    .optional()
    .transform((value) => (isPresent(value) ? value : defaultValue))
    .describe(note)
}

/** 缺判别字段时从 action 专属字段推断；命中多个 action 时返回 undefined，歧义不猜。 */
export function inferActionFromFields(
  input: Record<string, unknown>,
  map: Record<string, readonly string[]>
): string | undefined {
  const hits = Object.entries(map).filter(([, fields]) =>
    fields.some((field) => isPresent(input[field]))
  )
  return hits.length === 1 ? hits[0]![0] : undefined
}
