import { z } from 'zod'

import type { BrowserPageNavigationOptions, BrowserTargetActionKind, BrowserTargetActionValue } from '@velaros-ai/browser-core'
import { isEmpty,isPresent, isString } from '@velaros-ai/core'
import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'

import {
  type BrowserTargetHintInput,
} from './Target'

export const browserPerformTargetActionGuidedSchema = z
  .object({
    action: z.enum(['click', 'fill', 'select', 'clear', 'select_all', 'scroll_into_view', 'focus', 'hover', 'check', 'uncheck']).describe(
      parameterDescription({
        description: '要执行的动作。',
        values: [
          'click：点击目标元素。',
          'fill：向目标输入控件写入 value。',
          'select：选择原生 select 的一个或多个选项。',
          'clear：清空输入控件或可编辑内容。',
          'select_all：选中输入控件或可编辑区域内的文本。',
          'scroll_into_view：把目标滚动到视口中心。',
          'focus：聚焦目标元素。',
          'hover：把鼠标移动到目标元素中心。',
          'check：勾选复选框或单选项。',
          'uncheck：取消勾选复选框。',
        ],
        usage: ['action=fill 或 action=select 时必须传 value；select 可传字符串数组。'],
      })
    ),
    css: z.string().min(1).max(1000).optional().describe(
      parameterDescription({
        description: '优先使用的 CSS selector。',
      })
    ),
    text: z.string().min(1).max(500).optional().describe(
      parameterDescription({
        description: '元素可见文本。',
      })
    ),
    name: z.string().min(1).max(500).optional().describe(
      parameterDescription({
        description: '元素可访问性名称。',
      })
    ),
    role: z.string().min(1).max(80).optional().describe(
      parameterDescription({
        description: '元素可访问性角色。',
      })
    ),
    attributes: z.record(z.string(), z.string()).optional().describe(
      parameterDescription({
        description: '用于定位元素的属性。',
        notes: ['适合 data-testid、aria-* 等稳定属性。'],
      })
    ),
    value: z.union([z.string(), z.array(z.string().max(1000)).min(1).max(50)]).optional().describe(
      parameterDescription({
        description: 'fill 动作要写入的值，或 select 动作要选择的选项值/文本。',
        usage: ['action=fill 使用字符串；action=select 可使用字符串或字符串数组。'],
      })
    ),
  })
  .superRefine((input, issueCtx) => {
    const hasTarget =
      !!input.css || !!input.text || !!input.name || !isEmpty(Object.keys(input.attributes ?? {}))
    if (!hasTarget) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['css'],
        message: '至少提供 css、text、name 或 attributes 中的一项。',
      })
    }
    if (input.action === 'fill' && !isString(input.value)) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'fill 动作必须提供字符串 value。',
      })
    }
    if (input.action === 'select' && !isPresent(input.value)) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'select 动作必须提供 value。',
      })
    }
  })

export type BrowserPerformTargetActionGuidedInput = z.infer<typeof browserPerformTargetActionGuidedSchema>

export function normalizeBrowserPerformTargetActionGuided(input: BrowserPerformTargetActionGuidedInput): {
  action: BrowserTargetActionKind
  target: BrowserTargetHintInput
  value?: BrowserTargetActionValue
} {
  return {
    action: input.action,
    value: input.value,
    target: {
      css: input.css,
      text: input.text,
      name: input.name,
      role: input.role,
      attributes: input.attributes,
    },
  }
}

export const browserNavigatePageGuidedSchema = z
  .object({
    action: z.enum(['back', 'forward', 'reload', 'goto']).optional().describe(
      parameterDescription({
        description: '导航动作。',
        values: [
          'back：后退。',
          'forward：前进。',
          'reload：刷新。',
          'goto：跳转到 url。',
        ],
        notes: ['提供 url 且省略 action 时默认 goto。'],
      })
    ),
    url: z.string().min(1).max(2048).optional().describe(
      parameterDescription({
        description: '要跳转的 URL。',
        usage: ['action=goto 时必须提供。'],
      })
    ),
  })
  .superRefine((input, issueCtx) => {
    if (!input.action && !input.url?.trim()) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: '必须提供 action，或提供 url 进行 goto。',
      })
    }
    if (input.action === 'goto' && !input.url?.trim()) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'goto 导航必须提供 url。',
      })
    }
  })

export type BrowserNavigatePageGuidedInput = z.infer<typeof browserNavigatePageGuidedSchema>

export function normalizeBrowserNavigatePageGuided(input: BrowserNavigatePageGuidedInput): {
  action: BrowserPageNavigationOptions['action']
  url?: string
} {
  return {
    action: input.action ?? 'goto',
    url: input.url,
  }
}

export const browserClickCoordinatesGuidedSchema = z.object({
  x: z.number().int().min(0).max(10000).describe(
    parameterDescription({
      description: '视口内横向坐标。',
    })
  ),
  y: z.number().int().min(0).max(10000).describe(
    parameterDescription({
      description: '视口内纵向坐标。',
    })
  ),
  waitForNavigation: z.boolean().optional().describe(
    parameterDescription({
      description: '点击后是否等待可能的页面导航完成。',
    })
  ),
})

export type BrowserClickCoordinatesGuidedInput = z.infer<typeof browserClickCoordinatesGuidedSchema>

export function normalizeBrowserClickCoordinatesGuided(input: BrowserClickCoordinatesGuidedInput): {
  x: number
  y: number
  waitForNavigation?: boolean
} {
  return {
    x: input.x,
    y: input.y,
    waitForNavigation: input.waitForNavigation,
  }
}
