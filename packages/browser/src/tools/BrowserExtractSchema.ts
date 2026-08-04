import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'

const browserExtractActionSchema = z.enum(['table', 'list', 'paginate', 'content'])

const commonSaveFields = {
  save: z.boolean().optional().describe(
    parameterDescription({
      description: '是否把提取结果保存为 extract 产物。',
    })
  ),
  name: z.string().min(1).max(120).optional().describe(
    parameterDescription({
      description: '保存 extract 产物时使用的名称。',
      usage: ['仅 save=true 时使用。'],
    })
  ),
}

const ignoreSelectorsSchema = z.array(z.string().min(1).max(1000)).max(50).optional().describe(
  parameterDescription({
    description: '正文提取时排除的 CSS selector 或 XPath（//... 或 xpath=...）列表。',
    notes: ['用于过滤 nav、sidebar、cookie banner、广告等噪音子树。'],
  })
)

const browserExtractExactSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('table'),
      selector: z.string().optional().describe(
        parameterDescription({
          description: '定位目标表格的 CSS selector 或 XPath（//... 或 xpath=...）。',
          notes: ['省略时按 tableIndex 选择页面表格。'],
        })
      ),
      tableIndex: z.number().int().min(0).max(50).optional().describe(
        parameterDescription({
          description: '当页面有多张表格时选择第几张。',
          notes: ['从 0 开始，默认 0。'],
        })
      ),
      maxRows: z.number().int().positive().max(2000).optional().describe(
        parameterDescription({
          description: '最多提取多少行。',
          notes: ['默认 200。'],
        })
      ),
      ...commonSaveFields,
    })
    ,
  z
    .object({
      action: z.literal('list'),
      selector: z.string().optional().describe(
        parameterDescription({
          description: '定位列表容器的 CSS selector 或 XPath（//... 或 xpath=...）。',
          notes: ['省略时自动检测 ul、ol、article、.item 等常见结构。'],
        })
      ),
      maxItems: z.number().int().positive().max(500).optional().describe(
        parameterDescription({
          description: '最多提取多少条。',
          notes: ['默认 50。'],
        })
      ),
      ...commonSaveFields,
    })
    ,
  z
    .object({
      action: z.literal('paginate'),
      selector: z.string().optional().describe(
        parameterDescription({
          description: '列表容器 CSS selector 或 XPath（//... 或 xpath=...）。',
          usage: ['会透传给每页列表提取。'],
        })
      ),
      maxPages: z.number().int().positive().max(20).optional().describe(
        parameterDescription({
          description: '最多翻几页。',
          notes: ['默认 5。'],
        })
      ),
      maxItemsPerPage: z.number().int().positive().max(500).optional().describe(
        parameterDescription({
          description: '每页最多提取多少条。',
          notes: ['默认 50。'],
        })
      ),
      nextPageSelector: z.string().optional().describe(
        parameterDescription({
          description: '下一页按钮的 CSS selector。',
          notes: ['省略时自动检测常见分页控件。'],
        })
      ),
      ...commonSaveFields,
    })
    ,
  z
    .object({
      action: z.literal('content'),
      format: z.enum(['plain', 'markdown', 'html']).optional().describe(
        parameterDescription({
          description: '输出格式。',
          notes: ['默认 markdown。'],
        })
      ),
      selector: z.string().optional().describe(
        parameterDescription({
          description: '限定提取范围的 CSS selector 或 XPath（//... 或 xpath=...）。',
          notes: ['省略时自动选择 main/article 或 body。'],
        })
      ),
      ignoreSelectors: ignoreSelectorsSchema,
      maxChars: z.number().int().positive().max(200000).optional().describe(
        parameterDescription({
          description: '最多返回多少字符。',
          notes: ['默认 50000。'],
        })
      ),
      save: z.boolean().optional().describe(
        parameterDescription({
          description: '是否保存到 extracts/ 目录。',
          notes: ['默认 false。'],
        })
      ),
      name: z.string().min(1).max(120).optional().describe(
        parameterDescription({
          description: '保存时的产物名称。',
          usage: ['仅 save=true 时使用。'],
        })
      ),
    })
    ,
])

const browserExtractSchema = z
  .object({
    action: browserExtractActionSchema.describe(
      parameterDescription({
        description: '要执行的页面结构化提取动作。',
        values: [
          'table：提取 HTML table 为 headers/rows。',
          'list：提取列表/搜索结果条目。',
          'paginate：翻页提取列表并合并结果。',
          'content：提取正文为 plain/markdown/html。',
        ],
      })
    ),
    selector: z.string().optional().describe(
      parameterDescription({
        description: '限定 table/list/content/paginate 的 CSS selector 或 XPath（//... 或 xpath=...）。',
      })
    ),
    ignoreSelectors: ignoreSelectorsSchema,
    tableIndex: z.number().transform((value) => Math.min(50, Math.max(0, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'table 动作选择第几张表格。',
        notes: ['范围 [0,50],超出自动钳制。'],
      })
    ),
    maxRows: z.number().transform((value) => Math.min(2000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'table 动作最多提取多少行。',
        notes: ['上限 2000,超出自动钳制。'],
      })
    ),
    maxItems: z.number().transform((value) => Math.min(500, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'list 动作最多提取多少条。',
        notes: ['上限 500,超出自动钳制。'],
      })
    ),
    maxPages: z.number().transform((value) => Math.min(20, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'paginate 动作最多翻几页。',
        notes: ['上限 20,超出自动钳制。'],
      })
    ),
    maxItemsPerPage: z.number().transform((value) => Math.min(500, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'paginate 动作每页最多提取多少条。',
        notes: ['上限 500,超出自动钳制。'],
      })
    ),
    nextPageSelector: z.string().optional().describe(
      parameterDescription({
        description: 'paginate 动作下一页按钮的 CSS selector。',
      })
    ),
    format: z.enum(['plain', 'markdown', 'html']).optional().describe(
      parameterDescription({
        description: 'content 动作的输出格式。',
      })
    ),
    maxChars: z.number().transform((value) => Math.min(200000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'content 动作最多返回多少字符。',
        notes: ['上限 200000,超出自动钳制。'],
      })
    ),
    save: z.boolean().optional().describe(
      parameterDescription({
        description: '是否把提取结果保存为 artifact。',
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '保存 artifact 时使用的名称。',
      })
    ),
  })
  .superRefine((input, ctx) => {
    const exactParseResult = browserExtractExactSchema.safeParse(input)
    if (exactParseResult.success) return

    for (const issue of exactParseResult.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      })
    }
  })

function parseBrowserExtractInput(input: unknown): z.output<typeof browserExtractExactSchema> {
  const parsed = browserExtractSchema.parse(input)
  const exactParseResult = browserExtractExactSchema.safeParse(parsed)
  if (!exactParseResult.success) throw exactParseResult.error

  return exactParseResult.data
}

export {
  browserExtractSchema,
  parseBrowserExtractInput,
}
