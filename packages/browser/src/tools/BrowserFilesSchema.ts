import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import {
  applyDefaultRecursiveMaxDepth,
  optionalReadEndLine,
  optionalReadMaxChars,
  optionalReadStartLine,
  refineBoundedReadInput,
  requiredResultLimit,
} from '@velaros-ai/agent/tool-contract'

const browserFilesActionSchema = z.enum([
  'list_files',
  'read_file',
  'write_file',
  'list_artifacts',
  'write_artifact',
  'save_page_snapshot',
])

const browserFilesExactSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list_files'),
      path: z.string().optional().describe(
        parameterDescription({
          description: '相对于当前网站工作区的子路径。',
        })
      ),
      recursive: z.boolean().optional().describe(
        parameterDescription({
          description: '是否递归列出子目录。',
          usage: ['recursive=true 时必须传 maxDepth。'],
        })
      ),
      maxDepth: z.number().int().min(0).max(12).optional().describe(
        parameterDescription({
          description: '递归最大深度。',
        })
      ),
      limit: requiredResultLimit(500, '最多返回多少项'),
    })
    .transform(applyDefaultRecursiveMaxDepth),
  z
    .object({
      action: z.literal('read_file'),
      path: z.string().min(1).describe(
        parameterDescription({
          description: '相对于当前网站工作区的文件路径。',
        })
      ),
      startLine: optionalReadStartLine('起始行号，从 1 开始'),
      endLine: optionalReadEndLine('结束行号，包含该行'),
      maxChars: optionalReadMaxChars(200000, '最多返回多少字符'),
    })
    .superRefine(refineBoundedReadInput),
  z.object({
    action: z.literal('write_file'),
    path: z.string().min(1).describe(
      parameterDescription({
        description: '相对于当前网站工作区的文件路径。',
      })
    ),
    content: z.string().describe(
      parameterDescription({
        description: '要写入的 UTF-8 文本内容。',
      })
    ),
    overwrite: z.boolean().optional().describe(
      parameterDescription({
        description: '目标文件已存在时是否允许整体覆盖。',
      })
    ),
  }),
  z.object({
    action: z.literal('list_artifacts'),
    kind: z.enum(['page', 'recipe', 'extract', 'note', 'run']).optional().describe(
      parameterDescription({
        description: '要查看的 artifact 类型。',
      })
    ),
    limit: requiredResultLimit(300, '最多返回多少项'),
  }),
  z.object({
    action: z.literal('write_artifact'),
    kind: z.enum(['page', 'recipe', 'extract', 'note', 'run']).describe(
      parameterDescription({
        description: '产物类型。',
      })
    ),
    format: z.enum(['json', 'text', 'markdown', 'html']).describe(
      parameterDescription({
        description: '产物格式。',
      })
    ),
    content: z.string().describe(
      parameterDescription({
        description: '要写入的 UTF-8 文本内容。',
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '可选产物名称。',
      })
    ),
    overwrite: z.boolean().optional().describe(
      parameterDescription({
        description: '目标 artifact 已存在时是否允许覆盖。',
      })
    ),
  }),
  z.object({
    action: z.literal('save_page_snapshot'),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '可选快照名称。',
      })
    ),
    includeHtml: z.boolean().optional().describe(
      parameterDescription({
        description: '是否把裁剪后的 HTML 一起保存到快照里。',
      })
    ),
    maxTextChars: z.number().int().positive().max(100000).optional().describe(
      parameterDescription({
        description: '最多保存多少正文字符。',
      })
    ),
    maxHtmlChars: z.number().int().positive().max(100000).optional().describe(
      parameterDescription({
        description: '最多保存多少 HTML 字符。',
      })
    ),
    overwrite: z.boolean().optional().describe(
      parameterDescription({
        description: '目标快照已存在时是否允许覆盖。',
      })
    ),
  }),
])

const browserFilesSchema = z
  .object({
    action: browserFilesActionSchema.describe(
      parameterDescription({
        description: '要执行的浏览器工作区文件或 artifact 动作。',
        values: [
          'list_files：列出普通文件路径。',
          'read_file：读取普通文件，必须传 endLine 或 maxChars。',
          'write_file：写入普通文件。',
          'list_artifacts：列出标准 artifact。',
          'write_artifact：写入标准 artifact。',
          'save_page_snapshot：保存当前页面快照。',
        ],
      })
    ),
    path: z.string().min(1).optional().describe(
      parameterDescription({
        description: '普通文件动作使用的当前网站工作区相对路径。',
      })
    ),
    recursive: z.boolean().optional().describe(
      parameterDescription({
        description: 'list_files 是否递归列出子目录。',
      })
    ),
    maxDepth: z.number().int().min(0).max(12).optional().describe(
      parameterDescription({
        description: 'list_files 递归最大深度。',
      })
    ),
    limit: z.number().int().min(1).max(500).optional().describe(
      parameterDescription({
        description: 'list_files/list_artifacts 最多返回多少项。',
      })
    ),
    startLine: optionalReadStartLine('read_file 起始行号，从 1 开始'),
    endLine: optionalReadEndLine('read_file 结束行号，包含该行'),
    maxChars: optionalReadMaxChars(200000, 'read_file 最多返回多少字符'),
    content: z.string().optional().describe(
      parameterDescription({
        description: 'write_file/write_artifact 要写入的 UTF-8 文本内容。',
      })
    ),
    kind: z.enum(['page', 'recipe', 'extract', 'note', 'run']).optional().describe(
      parameterDescription({
        description: 'artifact 类型。',
      })
    ),
    format: z.enum(['json', 'text', 'markdown', 'html']).optional().describe(
      parameterDescription({
        description: 'write_artifact 产物格式。',
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: 'artifact 或快照名称。',
      })
    ),
    includeHtml: z.boolean().optional().describe(
      parameterDescription({
        description: 'save_page_snapshot 是否保存 HTML。',
      })
    ),
    maxTextChars: z.number().int().positive().max(100000).optional().describe(
      parameterDescription({
        description: 'save_page_snapshot 最多保存多少正文字符。',
      })
    ),
    maxHtmlChars: z.number().int().positive().max(100000).optional().describe(
      parameterDescription({
        description: 'save_page_snapshot 最多保存多少 HTML 字符。',
      })
    ),
    overwrite: z.boolean().optional().describe(
      parameterDescription({
        description: '写入目标已存在时是否允许覆盖。',
      })
    ),
  })
  .superRefine((input, ctx) => {
    const exactParseResult = browserFilesExactSchema.safeParse(input)
    if (exactParseResult.success) return

    for (const issue of exactParseResult.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      })
    }
  })

function parseBrowserFilesInput(input: unknown): z.output<typeof browserFilesExactSchema> {
  const parsed = browserFilesSchema.parse(input)
  const exactParseResult = browserFilesExactSchema.safeParse(parsed)
  if (!exactParseResult.success) throw exactParseResult.error
  return exactParseResult.data
}

export {
  browserFilesSchema,
  parseBrowserFilesInput,
}
