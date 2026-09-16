/**
 * 宽容 schema 的原语：实现在 `@velaros-ai/tool-contract`，这里按原名转发。
 * 使用边界（哪些调整保持用户意图、哪些必须明确纠正）写在工具契约那边的 `ToolInputForgivenessApi` 上方。
 */

import type { z } from 'zod'

import { toolInputForgiveness } from '@velaros-ai/tool-contract'

import type { AppliedAdjustment } from '../../types/toolkit.js'

/** 对允许收紧的资源/显示预算钳制并取整；调整应通过 buildAppliedAdjustments 回显。 */
export function clampedInt(min: number, max: number): z.ZodType<number, number> {
  return toolInputForgiveness.clampedInt(min, max)
}

/** 铁律⑤:可选参数带缺省——比 zod .default 多一层语义:缺省值本身进 describe 提示。 */
export function withDefaultNote<T extends z.ZodType>(
  schema: T,
  defaultValue: NonNullable<z.output<T>>,
  note: string
): z.ZodType<NonNullable<z.output<T>>> {
  return toolInputForgiveness.withDefaultNote(schema, defaultValue, note)
}

/** 对明确声明优先级的等价输入选取首项，并返回被忽略项；不能用来猜测冲突的目标或操作。 */
export function preferFirst<T>(
  input: Record<string, unknown>,
  keys: readonly string[]
): { value?: T; usedKey?: string; ignoredKeys: string[] } {
  return toolInputForgiveness.preferFirst<T>(input, keys)
}

/** 铁律②(空输入):空数组/空对象输入视为 no-op 而不是错误——返回统一判定。 */
export function emptyIsNoop(value: unknown): boolean {
  return toolInputForgiveness.emptyIsNoop(value)
}

/** 铁律⑥:缺判别字段时从 action 专属字段推断；命中多个 action 时返回 undefined，歧义不猜。 */
export function inferActionFromFields(
  input: Record<string, unknown>,
  map: Record<string, readonly string[]>
): string | undefined {
  return toolInputForgiveness.inferAction(input, map)
}

/** 铁律⑧(回显):把本次系统替模型做的调整打成工具结果里的 `appliedAdjustments` 字段；一条都没有时返回空对象。 */
export function buildAppliedAdjustments(
  adjustments: readonly AppliedAdjustment[]
): { appliedAdjustments: AppliedAdjustment[] } | Record<string, never> {
  return toolInputForgiveness.appliedAdjustments(adjustments)
}

/** 铁律①(结果侧):引用参数 miss 时的有效项提示，带 1-based 序号做可引用句柄。 */
export function buildValidItemsHint(
  label: string,
  items: readonly string[],
  maxItems?: number
): string {
  return toolInputForgiveness.validItemsHint(label, items, maxItems)
}
