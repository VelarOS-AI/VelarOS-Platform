import { z } from 'zod'

import { isArray, isBlank, isEmpty, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { clampRounded } from '@velaros-ai/core/utils/number'

/**
 * 可选的宽容 schema 原语；工具必须先明确哪些调整保持用户意图。
 *
 * 使用边界:
 *  ① 引用集合参数 miss 时结果要回带有效项清单+可引用句柄(结果侧,见 buildValidItemsHint)
 *  ② preferFirst 只用于已声明优先级且语义等价的输入；操作/目标歧义必须明确纠正。
 *     emptyIsNoop 仅用于已声明空输入无效果的操作，不能替代缺失参数校验。
 *  ③ clampedInt 适用于可安全收紧的显示/资源预算；源码坐标和精确数量不能静默钳制。
 *  ④ 无关附加元数据可 strip；决定操作、目标和正文的合同应 strict，避免忽略显式意图。
 *  ⑤ withDefaultNote 仅用于已声明的安全默认；写入正文、目标引用和确认选择不补默认。
 *  ⑥ inferActionFromFields 仅从足以唯一证明操作的专属字段推断。
 *  ⑦ 自动过滤器/scaffold 不得静默否决显式意图
 *  ⑧ 系统替模型做的调整要回显(buildAppliedAdjustments)——钳了值/给了默认要让模型知道
 *
 * 注意:transform 会让 z.toJSONSchema 的 output 视图抛错——本仓 schema-bundle 已统一
 * io:'input',新消费方自建 bundle 时必须同样传 io:'input',否则工具退化零参数兜底
 * (真实事故,见 velar-agent-ux-unify 档案)。
 */

/** 对允许收紧的资源/显示预算钳制并取整；调整应通过 buildAppliedAdjustments 回显。 */
export function clampedInt(min: number, max: number): z.ZodType<number, number> {
  return z.number().transform((value) => clampRounded(value, min, max))
}

/** 铁律⑤:可选参数带缺省——比 zod .default 多一层语义:缺省值本身进 describe 提示。 */
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

/**
 * 对明确声明优先级的等价输入选取首项，并返回被忽略项；不能用来猜测冲突的目标或操作。
 */
export function preferFirst<T>(
  input: Record<string, unknown>,
  keys: readonly string[]
): { value?: T; usedKey?: string; ignoredKeys: string[] } {
  const present = keys.filter((key) => {
    const value = input[key]
    return isPresent(value) && (!isString(value) || !isEmpty(value))
  })
  const usedKey = present[0]
  return {
    value: isPresent(usedKey) ? (input[usedKey] as T) : undefined,
    usedKey,
    ignoredKeys: present.slice(1),
  }
}

/** 铁律②(空输入):空数组/空对象输入视为 no-op 而不是错误——返回统一判定。 */
export function emptyIsNoop(value: unknown): boolean {
  if (!isPresent(value)) return true
  if (isArray(value)) return isEmpty(value)
  if (isString(value)) return isBlank(value)
  if (isPlainObject(value)) return isEmpty(Object.keys(value))
  return false
}

/**
 * 铁律⑥:缺判别字段时从 action 专属字段推断。
 * map 的键是 action 名,值是"出现即证明该 action"的专属字段清单;命中多个 action 时
 * 返回 undefined(歧义不猜,让校验给出可操作错误)。
 */
export function inferActionFromFields(
  input: Record<string, unknown>,
  map: Record<string, readonly string[]>
): string | undefined {
  const hits = Object.entries(map).filter(([, fields]) =>
    fields.some((field) => isPresent(input[field]))
  )
  return hits.length === 1 ? hits[0]![0] : undefined
}

/** 铁律⑧:系统替模型做过的调整(钳制/缺省/别名采用)统一回显形状。 */
export interface AppliedAdjustment {
  field: string
  action: 'clamped' | 'defaulted' | 'aliased' | 'ignored' | 'coerced' | 'normalized'
  detail: string
}

export function buildAppliedAdjustments(
  adjustments: readonly AppliedAdjustment[]
): { appliedAdjustments: AppliedAdjustment[] } | Record<string, never> {
  return isEmpty(adjustments) ? {} : { appliedAdjustments: [...adjustments] }
}

/**
 * 铁律①(结果侧):引用参数 miss 时的有效项提示。返回可直接塞进错误 message 或
 * 结果 metadata 的清单文本;items 建议 ≤10 条,带 1-based 序号做可引用句柄。
 */
export function buildValidItemsHint(
  label: string,
  items: readonly string[],
  maxItems = 10
): string {
  if (isEmpty(items)) return `${label}:当前为空。`
  const shown = items.slice(0, maxItems)
  const lines = shown.map((item, index) => `${index + 1}. ${item}`)
  const suffix = items.length > shown.length ? `\n(另有 ${items.length - shown.length} 项未列出)` : ''
  return `${label}(用 1-based 序号或精确名称引用):\n${lines.join('\n')}${suffix}`
}
