import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'

const recipeTemplateSchema = z.enum(['login', 'search', 'pagination', 'form_submit'])
const browserRecipeActionSchema = z.enum([
  'generate_skeleton',
  'generate_skeleton_from_snapshot',
  'read_skeleton',
  'run_skeleton',
  'read_run',
  'rerun_from_run',
])

const inputsSchema = z.record(z.string(), z.string()).describe(
  parameterDescription({
    description: '按 recipe input.name 传入的字段值。',
  })
)
const variablesSchema = z.record(z.string(), z.string()).describe(
  parameterDescription({
    description: '执行时用于替换 inputs 中 %variableName% 占位符的变量值。',
    notes: ['变量值只用于页面执行，不写入 runs/ 运行记录。'],
  })
)

const recipePathSchema = z.string().min(1).describe(
  parameterDescription({
    description: '当前网站浏览器工作区内的 recipe skeleton 路径。',
    usage: ['通常是 recipes/xxx.json。'],
  })
)

const runPathSchema = z.string().min(1).describe(
  parameterDescription({
    description: '当前网站浏览器工作区内的运行记录路径。',
    usage: ['通常是 runs/xxx.json。'],
  })
)

const runOptionsFields = {
  inputs: inputsSchema.optional(),
  variables: variablesSchema.optional(),
  maxSteps: z.number().int().positive().max(50).optional().describe(
    parameterDescription({
      description: '最多执行多少个可执行步骤。',
    })
  ),
  dryRun: z.boolean().optional().describe(
    parameterDescription({
      description: '是否只预检而不执行页面动作。',
    })
  ),
  stopOnMiss: z.boolean().optional().describe(
    parameterDescription({
      description: 'target 未命中时是否停止。',
      notes: ['默认 true。'],
    })
  ),
  saveRun: z.boolean().optional().describe(
    parameterDescription({
      description: '是否保存 run artifact。',
      notes: ['默认 true。'],
    })
  ),
  saveSnapshots: z.boolean().optional().describe(
    parameterDescription({
      description: '是否保存 before/after 页面快照。',
      notes: ['默认 true。'],
    })
  ),
  runName: z.string().min(1).max(120).optional().describe(
    parameterDescription({
      description: '保存 run artifact 时使用的名称。',
    })
  ),
}

const browserRecipeExactSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('generate_skeleton'),
      name: z.string().min(1).max(120).optional().describe(
        parameterDescription({
          description: '可选 recipe 名称。',
          notes: ['省略时根据当前页面 URL 生成。'],
        })
      ),
      saveSnapshot: z.boolean().optional().describe(
        parameterDescription({
          description: '生成 skeleton 前是否同步保存页面 snapshot。',
          notes: ['默认 true。'],
        })
      ),
      snapshotName: z.string().min(1).max(120).optional().describe(
        parameterDescription({
          description: '同步保存页面 snapshot 时使用的名称。',
          usage: ['仅 saveSnapshot=true 时使用。'],
        })
      ),
      overwriteSnapshot: z.boolean().optional().describe(
        parameterDescription({
          description: '是否覆盖同名页面 snapshot。',
          usage: ['仅 saveSnapshot=true 时使用。'],
          notes: ['默认 true。'],
        })
      ),
      maxTextChars: z.number().int().positive().max(100000).optional().describe(
        parameterDescription({
          description: '生成 skeleton 时最多读取多少正文字符。',
        })
      ),
      overwrite: z.boolean().optional().describe(
        parameterDescription({
          description: '目标 recipe 文件已存在时是否允许覆盖。',
        })
      ),
      template: recipeTemplateSchema.optional().describe(
        parameterDescription({
          description: '预设 recipe 模板。',
        })
      ),
    })
    ,
  z
    .object({
      action: z.literal('generate_skeleton_from_snapshot'),
      path: z.string().min(1).describe(
        parameterDescription({
          description: '当前网站浏览器工作区内的页面快照路径。',
          usage: ['通常是 pages/xxx.json。'],
        })
      ),
      name: z.string().min(1).max(120).optional().describe(
        parameterDescription({
          description: '可选 recipe 名称。',
          notes: ['省略时根据快照 URL 生成。'],
        })
      ),
      overwrite: z.boolean().optional().describe(
        parameterDescription({
          description: '目标 recipe 已存在时是否允许覆盖。',
        })
      ),
      template: recipeTemplateSchema.optional().describe(
        parameterDescription({
          description: '预设 recipe 模板。',
        })
      ),
    })
    ,
  z
    .object({
      action: z.literal('read_skeleton'),
      path: recipePathSchema,
      inputs: inputsSchema.optional(),
      maxSteps: z.number().int().positive().max(50).optional().describe(
        parameterDescription({
          description: '最多预览多少个可执行步骤。',
        })
      ),
    })
    ,
  z
    .object({
      action: z.literal('run_skeleton'),
      path: recipePathSchema,
      ...runOptionsFields,
    })
    ,
  z
    .object({
      action: z.literal('read_run'),
      path: runPathSchema,
    })
    ,
  z
    .object({
      action: z.literal('rerun_from_run'),
      path: runPathSchema,
      ...runOptionsFields,
    })
    ,
])

const browserRecipeSchema = z
  .object({
    action: browserRecipeActionSchema.describe(
      parameterDescription({
        description: '要执行的 browser recipe 动作。',
        values: [
          'generate_skeleton：基于当前页面生成 recipe skeleton。',
          'generate_skeleton_from_snapshot：基于已保存页面快照生成 skeleton。',
          'read_skeleton：读取并预览 skeleton。',
          'run_skeleton：执行或 dryRun skeleton。',
          'read_run：读取历史运行记录。',
          'rerun_from_run：根据历史 run record 重跑。',
        ],
      })
    ),
    path: z.string().min(1).optional().describe(
      parameterDescription({
        description: 'recipe、snapshot 或 run artifact 路径。',
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '生成 recipe 或 artifact 时的名称。',
      })
    ),
    saveSnapshot: z.boolean().optional().describe(
      parameterDescription({
        description: 'generate_skeleton 是否同步保存页面 snapshot。',
      })
    ),
    snapshotName: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '保存页面 snapshot 时使用的名称。',
      })
    ),
    overwriteSnapshot: z.boolean().optional().describe(
      parameterDescription({
        description: '是否覆盖同名页面 snapshot。',
      })
    ),
    maxTextChars: z.number().transform((value) => Math.min(100000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '生成 skeleton 时最多读取多少正文字符。',
        notes: ['上限 100000,超出自动钳制。'],
      })
    ),
    overwrite: z.boolean().optional().describe(
      parameterDescription({
        description: '目标 recipe 已存在时是否允许覆盖。',
      })
    ),
    template: recipeTemplateSchema.optional().describe(
      parameterDescription({
        description: '预设 recipe 模板。',
      })
    ),
    inputs: inputsSchema.optional(),
    variables: variablesSchema.optional(),
    maxSteps: z.number().transform((value) => Math.min(50, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '预览或执行时最多处理多少个步骤。',
        notes: ['上限 50,超出自动钳制。'],
      })
    ),
    dryRun: z.boolean().optional().describe(
      parameterDescription({
        description: 'run/rerun 是否只预检不执行页面动作。',
      })
    ),
    stopOnMiss: z.boolean().optional().describe(
      parameterDescription({
        description: 'target 未命中时是否停止。',
      })
    ),
    saveRun: z.boolean().optional().describe(
      parameterDescription({
        description: '是否保存 run artifact。',
      })
    ),
    saveSnapshots: z.boolean().optional().describe(
      parameterDescription({
        description: '是否保存 before/after 页面快照。',
      })
    ),
    runName: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '保存 run artifact 时使用的名称。',
      })
    ),
  })
  .superRefine((input, ctx) => {
    const exactParseResult = browserRecipeExactSchema.safeParse(input)
    if (exactParseResult.success) return

    for (const issue of exactParseResult.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      })
    }
  })

function parseBrowserRecipeInput(input: unknown): z.output<typeof browserRecipeExactSchema> {
  const parsed = browserRecipeSchema.parse(input)
  const exactParseResult = browserRecipeExactSchema.safeParse(parsed)
  if (!exactParseResult.success) throw exactParseResult.error

  return exactParseResult.data
}

export {
  browserRecipeSchema,
  parseBrowserRecipeInput,
}
