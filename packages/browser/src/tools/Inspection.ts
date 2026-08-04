import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { requiredResultLimit } from '@velaros-ai/agent/tool-contract'


export const browserQueryElementsSchema = z.object({
  selector: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      parameterDescription({
        description: 'CSS selector；一层同源 iframe 内元素可用 iframe selector >> inner selector。',
        notes: ['例如 main article、[data-testid="price"] 或 iframe[name="checkout"] >> .total。'],
      })
    ),
  attributes: z
    .array(z.string().min(1).max(80))
    .max(20)
    .optional()
    .describe(
      parameterDescription({
        description: '要额外读取的属性名。',
        notes: ['省略时读取常用定位属性。'],
      })
    ),
  includeHtml: z.boolean().optional().describe(
    parameterDescription({
      description: '是否返回每个元素裁剪后的 outerHTML。',
    })
  ),
  limit: requiredResultLimit(100, '最多返回多少个匹配元素'),
  maxTextChars: z
    .number()
    .int()
    .positive()
    .max(20000)
    .optional()
    .describe(
      parameterDescription({
        description: '每个元素最多返回多少文本字符。',
        notes: ['默认 2000。'],
      })
    ),
  maxHtmlChars: z
    .number()
    .int()
    .positive()
    .max(50000)
    .optional()
    .describe(
      parameterDescription({
        description: '每个元素最多返回多少 HTML 字符。',
        usage: ['仅 includeHtml=true 时使用。'],
        notes: ['默认 5000。'],
      })
    ),
})

export type BrowserQueryElementsInput = z.infer<typeof browserQueryElementsSchema>

export const browserQueryElementsGuidedSchema = browserQueryElementsSchema.extend({
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe(
      parameterDescription({
        description: '最多返回多少个匹配元素。',
        notes: ['默认 20。'],
      })
    ),
})

export type BrowserQueryElementsGuidedInput = z.infer<typeof browserQueryElementsGuidedSchema>

export function normalizeBrowserQueryElementsGuided(
  input: BrowserQueryElementsGuidedInput
): BrowserQueryElementsInput {
  return {
    ...input,
    limit: input.limit ?? 20,
  }
}

export const browserGetPageDiagnosticsSchema = z.object({
  limit: requiredResultLimit(300, '最多返回多少条诊断事件'),
  clear: z.boolean().optional().describe(
    parameterDescription({
      description: '读取后是否清空已缓存的诊断事件。',
    })
  ),
})

export type BrowserGetPageDiagnosticsInput = z.infer<typeof browserGetPageDiagnosticsSchema>

export const browserGetPageDiagnosticsGuidedSchema = browserGetPageDiagnosticsSchema.extend({
  limit: z
    .number()
    .int()
    .positive()
    .max(300)
    .optional()
    .describe(
      parameterDescription({
        description: '最多返回多少条诊断事件。',
        notes: ['默认 50。'],
      })
    ),
})

export type BrowserGetPageDiagnosticsGuidedInput = z.infer<typeof browserGetPageDiagnosticsGuidedSchema>

export function normalizeBrowserGetPageDiagnosticsGuided(
  input: BrowserGetPageDiagnosticsGuidedInput
): BrowserGetPageDiagnosticsInput {
  return {
    ...input,
    limit: input.limit ?? 50,
  }
}

export const browserListNetworkEventsSchema = z.object({
  limit: requiredResultLimit(300, '最多读取多少条诊断事件'),
  clear: z.boolean().optional().describe(
    parameterDescription({
      description: '读取后是否清空已缓存的诊断事件。',
    })
  ),
  status: z.number().int().positive().max(999).optional().describe(
    parameterDescription({
      description: '只返回指定 HTTP status 的网络诊断事件。',
    })
  ),
  resourceType: z.string().trim().min(1).max(80).optional().describe(
    parameterDescription({
      description: '只返回指定 resourceType 的网络诊断事件。',
      notes: ['例如 Fetch、Script、Document。'],
    })
  ),
  failedOnly: z.boolean().optional().describe(
    parameterDescription({
      description: '只返回失败或异常级别的网络诊断事件。',
    })
  ),
})

export type BrowserListNetworkEventsInput = z.infer<typeof browserListNetworkEventsSchema>

export const browserListNetworkEventsGuidedSchema = browserListNetworkEventsSchema.extend({
  limit: z
    .number()
    .int()
    .positive()
    .max(300)
    .optional()
    .describe(
      parameterDescription({
        description: '最多读取多少条诊断事件。',
        notes: ['默认 50。'],
      })
    ),
})

export type BrowserListNetworkEventsGuidedInput = z.infer<typeof browserListNetworkEventsGuidedSchema>

export function normalizeBrowserListNetworkEventsGuided(
  input: BrowserListNetworkEventsGuidedInput
): BrowserListNetworkEventsInput {
  return {
    ...input,
    limit: input.limit ?? 50,
  }
}

export const browserGetNetworkResponseBodySchema = z.object({
  requestId: z.string().trim().min(1).max(200).describe(
    parameterDescription({
      description: 'browser:list_network_events 返回的网络 requestId。',
      notes: ['必须来自当前页面近期捕获到的网络事件。'],
    })
  ),
  maxChars: z.number().int().positive().max(200000).optional().describe(
    parameterDescription({
      description: '响应体最多返回多少字符。',
      notes: ['默认 20000，超出会截断并返回 bodyTruncated=true。'],
    })
  ),
})

export type BrowserGetNetworkResponseBodyInput = z.infer<
  typeof browserGetNetworkResponseBodySchema
>

export const browserGetNetworkResponseBodyGuidedSchema =
  browserGetNetworkResponseBodySchema.extend({
    maxChars: z.number().int().positive().max(200000).optional().describe(
      parameterDescription({
        description: '响应体最多返回多少字符。',
        notes: ['默认 20000。'],
      })
    ),
  })

export type BrowserGetNetworkResponseBodyGuidedInput = z.infer<
  typeof browserGetNetworkResponseBodyGuidedSchema
>

export function normalizeBrowserGetNetworkResponseBodyGuided(
  input: BrowserGetNetworkResponseBodyGuidedInput
): BrowserGetNetworkResponseBodyInput {
  return {
    ...input,
    maxChars: input.maxChars ?? 20000,
  }
}

export const browserGetNetworkRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(200).describe(
    parameterDescription({
      description: 'browser:list_network_events 返回的网络 requestId。',
      notes: ['必须来自当前页面近期捕获到的网络事件。'],
    })
  ),
  includeResponseBody: z.boolean().optional().describe(
    parameterDescription({
      description: '是否同时尝试读取响应体。',
      notes: ['默认 false；只需要 body 时也可以直接用 browser:get_network_response_body。'],
    })
  ),
  maxBodyChars: z.number().int().positive().max(200000).optional().describe(
    parameterDescription({
      description: '响应体最多返回多少字符。',
      usage: ['仅 includeResponseBody=true 时使用。'],
      notes: ['默认 20000。'],
    })
  ),
})

export type BrowserGetNetworkRequestInput = z.infer<typeof browserGetNetworkRequestSchema>

export const browserGetNetworkRequestGuidedSchema = browserGetNetworkRequestSchema.extend({
  includeResponseBody: z.boolean().optional().describe(
    parameterDescription({
      description: '是否同时返回响应体。',
      notes: ['默认 false。'],
    })
  ),
  maxBodyChars: z.number().int().positive().max(200000).optional().describe(
    parameterDescription({
      description: '响应体最多返回多少字符。',
      notes: ['默认 20000。'],
    })
  ),
})

export type BrowserGetNetworkRequestGuidedInput = z.infer<
  typeof browserGetNetworkRequestGuidedSchema
>

export function normalizeBrowserGetNetworkRequestGuided(
  input: BrowserGetNetworkRequestGuidedInput
): BrowserGetNetworkRequestInput {
  return {
    ...input,
    includeResponseBody: !!input.includeResponseBody,
    maxBodyChars: input.maxBodyChars ?? 20000,
  }
}

export const browserListConsoleEventsSchema = z.object({
  limit: requiredResultLimit(300, '最多读取多少条诊断事件'),
  clear: z.boolean().optional().describe(
    parameterDescription({
      description: '读取后是否清空已缓存的诊断事件。',
    })
  ),
  level: z.enum(['debug', 'info', 'warning', 'error']).optional().describe(
    parameterDescription({
      description: '只返回指定 console level 的事件。',
    })
  ),
  errorsOnly: z.boolean().optional().describe(
    parameterDescription({
      description: '只返回 error level 的 console 事件。',
    })
  ),
})

export type BrowserListConsoleEventsInput = z.infer<typeof browserListConsoleEventsSchema>

export const browserListConsoleEventsGuidedSchema = browserListConsoleEventsSchema.extend({
  limit: z
    .number()
    .int()
    .positive()
    .max(300)
    .optional()
    .describe(
      parameterDescription({
        description: '最多读取多少条诊断事件。',
        notes: ['默认 50。'],
      })
    ),
})

export type BrowserListConsoleEventsGuidedInput = z.infer<typeof browserListConsoleEventsGuidedSchema>

export function normalizeBrowserListConsoleEventsGuided(
  input: BrowserListConsoleEventsGuidedInput
): BrowserListConsoleEventsInput {
  return {
    ...input,
    limit: input.limit ?? 50,
  }
}

export const browserListPageErrorsSchema = browserGetPageDiagnosticsSchema

export type BrowserListPageErrorsInput = z.infer<typeof browserListPageErrorsSchema>

export const browserListPageErrorsGuidedSchema = browserGetPageDiagnosticsGuidedSchema

export type BrowserListPageErrorsGuidedInput = z.infer<typeof browserListPageErrorsGuidedSchema>

export const normalizeBrowserListPageErrorsGuided = normalizeBrowserGetPageDiagnosticsGuided
