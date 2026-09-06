import { z } from 'zod'

import { isEmpty, toNullable } from '@velaros-ai/core'

import type { BrowserElementTargetHint } from '../core'

/**
 * 页面目标元素提示 schema。
 *
 * target 通常来自 inspect/query 返回结果，后续交互工具用它定位元素。
 */
export const browserTargetHintSchema = z
  .object({
    /** 来自一次页面 snapshot/inspection 的 generation 引用。 */
    ref: z.string().min(1).nullable().optional().describe(
      '页面观察返回的完整 ref，例如 @e3:g2。必须原样传回；新一次 inspect/标注截图会生成新的 generation。'
    ),
    /** 优先使用的 CSS selector。 */
    css: z.string().min(1).nullable().optional(),
    /** 可访问性角色，作为辅助定位信息。 */
    role: z.string().min(1).nullable().optional(),
    /** 元素可见文本。 */
    text: z.string().nullable().optional(),
    /** 可访问性名称。 */
    name: z.string().nullable().optional(),
    /** 同源 iframe 上下文；只用于限定目标所在 frame，本身不算定位线索。 */
    frame: z
      .object({
        css: z.string().min(1).nullable().optional(),
        name: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .optional(),
    /** data-testid、aria-* 等属性定位信息。 */
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((value, issueCtx) => {
    const attributes = value.attributes ? Object.keys(value.attributes) : []
    // 至少要有一种定位线索，否则 runtime 无法可靠找到目标元素。
    const hasTarget =
      !!value.ref ||
      !!value.css ||
      !!value.text ||
      !!value.name ||
      !isEmpty(attributes)

    if (!hasTarget) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'target 至少需要提供 ref、css、text、name 或 attributes 中的一项。',
      })
    }
  })

export type BrowserTargetHintInput = z.infer<typeof browserTargetHintSchema>

/** 把外部输入归一化成 runtime 统一使用的 target hint。 */
export function normalizeBrowserTargetHint(target: BrowserTargetHintInput): BrowserElementTargetHint {
  const normalized: BrowserElementTargetHint = {
    ref: toNullable(target.ref),
    css: toNullable(target.css),
    role: toNullable(target.role),
    text: toNullable(target.text),
    name: toNullable(target.name),
    attributes: target.attributes ? target.attributes : {},
  }
  if (target.frame) {
    normalized.frame = {
      css: toNullable(target.frame.css),
      name: toNullable(target.frame.name),
      title: toNullable(target.frame.title),
      url: toNullable(target.frame.url),
    }
  }
  return normalized
}
