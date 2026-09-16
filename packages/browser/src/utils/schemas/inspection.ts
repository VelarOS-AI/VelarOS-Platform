import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
  requiredResultLimit,
} from '@velaros-ai/agent/tool-contract'

import type {
  BrowserGetNetworkRequestInput,
  BrowserGetNetworkResponseBodyInput,
  BrowserGetPageDiagnosticsInput,
  BrowserListConsoleEventsInput,
  BrowserListNetworkEventsInput,
  BrowserQueryElementsInput,
} from '../../types/tools'


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


/** guided 面的查元素入参补上缺省条数，转成基础面的形状。 */
export function normalizeBrowserQueryElementsGuided(
  input: z.infer<typeof browserQueryElementsGuidedSchema>
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
      description: '读取后是否清空诊断缓存；只清这次读取的种类。',
    })
  ),
})


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


/** guided 面的读诊断入参补上缺省条数，转成基础面的形状。 */
export function normalizeBrowserGetPageDiagnosticsGuided(
  input: z.infer<typeof browserGetPageDiagnosticsGuidedSchema>
): BrowserGetPageDiagnosticsInput {
  return {
    ...input,
    limit: input.limit ?? 50,
  }
}

export const browserListNetworkEventsSchema = z.object({
  limit: requiredResultLimit(300, '最多返回多少条网络事件（按种类过滤之后再取这么多条）'),
  clear: z.boolean().optional().describe(
    parameterDescription({
      description: '读取后是否清空诊断缓存；只清这次读取的种类。',
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


export const browserListNetworkEventsGuidedSchema = browserListNetworkEventsSchema.extend({
  limit: z
    .number()
    .int()
    .positive()
    .max(300)
    .optional()
    .describe(
      parameterDescription({
        description: '最多返回多少条网络事件（按种类过滤之后再取这么多条）。',
        notes: ['默认 50。'],
      })
    ),
})


/** guided 面的列网络事件入参补上缺省条数，转成基础面的形状。 */
export function normalizeBrowserListNetworkEventsGuided(
  input: z.infer<typeof browserListNetworkEventsGuidedSchema>
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


export const browserGetNetworkResponseBodyGuidedSchema =
  browserGetNetworkResponseBodySchema.extend({
    maxChars: z.number().int().positive().max(200000).optional().describe(
      parameterDescription({
        description: '响应体最多返回多少字符。',
        notes: ['默认 20000。'],
      })
    ),
  })


/** guided 面的读响应体入参补上缺省字符数，转成基础面的形状。 */
export function normalizeBrowserGetNetworkResponseBodyGuided(
  input: z.infer<typeof browserGetNetworkResponseBodyGuidedSchema>
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


/** guided 面的读请求详情入参补上缺省值，转成基础面的形状。 */
export function normalizeBrowserGetNetworkRequestGuided(
  input: z.infer<typeof browserGetNetworkRequestGuidedSchema>
): BrowserGetNetworkRequestInput {
  return {
    ...input,
    includeResponseBody: !!input.includeResponseBody,
    maxBodyChars: input.maxBodyChars ?? 20000,
  }
}

export const browserListConsoleEventsSchema = z.object({
  limit: requiredResultLimit(300, '最多返回多少条 console 事件（按种类过滤之后再取这么多条）'),
  clear: z.boolean().optional().describe(
    parameterDescription({
      description: '读取后是否清空诊断缓存；只清这次读取的种类。',
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


export const browserListConsoleEventsGuidedSchema = browserListConsoleEventsSchema.extend({
  limit: z
    .number()
    .int()
    .positive()
    .max(300)
    .optional()
    .describe(
      parameterDescription({
        description: '最多返回多少条 console 事件（按种类过滤之后再取这么多条）。',
        notes: ['默认 50。'],
      })
    ),
})


/** guided 面的列 console 事件入参补上缺省条数，转成基础面的形状。 */
export function normalizeBrowserListConsoleEventsGuided(
  input: z.infer<typeof browserListConsoleEventsGuidedSchema>
): BrowserListConsoleEventsInput {
  return {
    ...input,
    limit: input.limit ?? 50,
  }
}

export const browserListPageErrorsSchema = browserGetPageDiagnosticsSchema


export const browserListPageErrorsGuidedSchema = browserGetPageDiagnosticsGuidedSchema


export const normalizeBrowserListPageErrorsGuided = normalizeBrowserGetPageDiagnosticsGuided
