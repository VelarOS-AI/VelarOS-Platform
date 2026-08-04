import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { AppError } from '@velaros-ai/core/error'

import { browserRecipeSchema, parseBrowserRecipeInput } from './BrowserRecipeSchema'
import {
  BrowserArtifactReadCapability,
  BrowserArtifactWriteCapability,
  BrowserControlCapability,
} from './Capabilities'
import { browserRecipeArtifacts } from './RecipeArtifacts'
import { browserRecipeRunner } from './RecipeRun'
import { defineBrowserTool } from './Types'

/** 基于当前页面生成 recipe skeleton 的工具。 */
const browserGenerateRecipeSkeleton = defineBrowserTool<{
  name?: string
  saveSnapshot?: boolean
  snapshotName?: string
  overwriteSnapshot?: boolean
  maxTextChars?: number
  overwrite?: boolean
  template?: 'login' | 'search' | 'pagination' | 'form_submit'
}>({
  name: 'browser:generate_recipe_skeleton',
  role: 'edit',
  summary: '基于当前页面生成最小 recipe skeleton。',
  suitable: ['需要从当前页面沉淀候选自动化步骤，再逐步补全成可执行 recipe。'],
  forbidden: ['不要在页面尚未稳定或目标流程未到达时生成 recipe。'],
  protocol: ['先进入目标页面并确认状态；生成 skeleton 后读取路径再编辑或 dryRun。'],
  usage: ['可传 name；需要页面快照时保留 saveSnapshot=true；可传 template 选择流程骨架。'],
  examples: [{ template: "search", name: "site-search" }],
  notes: ['recipe 保存到当前网站工作区 recipes/ 目录。'],
  schema: z.object({
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        parameterDescription({
          description: '可选 recipe 名称。',
          notes: ['省略时根据当前页面 URL 生成。'],
        })
      ),
    saveSnapshot: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '生成 skeleton 前是否同步保存页面 snapshot。',
          notes: ['默认 true。'],
        })
      ),
    snapshotName: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        parameterDescription({
          description: '同步保存页面 snapshot 时使用的名称。',
          usage: ['仅 saveSnapshot=true 时使用。'],
        })
      ),
    overwriteSnapshot: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '是否覆盖同名页面 snapshot。',
          usage: ['仅 saveSnapshot=true 时使用。'],
          notes: ['默认 true。'],
        })
      ),
    maxTextChars: z
      .number()
      .transform((value) => Math.min(100000, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '生成 skeleton 时最多读取多少正文字符。',
          notes: ['上限 100000,超出自动钳制。'],
        })
      ),
    overwrite: z.boolean().optional().describe(
      parameterDescription({
        description: '目标 recipe 文件已存在时是否允许覆盖。',
      })
    ),
    template: z
      .enum(['login', 'search', 'pagination', 'form_submit'])
      .optional()
      .describe(
        parameterDescription({
          description: '预设 recipe 模板。',
          values: [
            'login：登录流程骨架。',
            'search：搜索流程骨架。',
            'pagination：翻页流程骨架。',
            'form_submit：表单提交流程骨架。',
          ],
          notes: ['选定后会在首部插入对应步骤骨架。'],
        })
      ),
  }),
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  // 具体流程放在 ArtifactHelper：inspect 页面 -> 可选保存 snapshot -> 保存 recipe。
  execute: browserRecipeArtifacts.generateSkeleton.bind(browserRecipeArtifacts),
})

/** 基于已保存页面快照生成 recipe skeleton 的工具。 */
const browserGenerateRecipeSkeletonFromSnapshot = defineBrowserTool<{
  path: string
  name?: string
  overwrite?: boolean
  template?: 'login' | 'search' | 'pagination' | 'form_submit'
}>({
  name: 'browser:generate_recipe_skeleton_from_snapshot',
  role: 'edit',
  summary: '从已保存页面快照生成 recipe skeleton。',
  suitable: ['需要复用 pages/ 下的自动快照或历史页面结构。'],
  forbidden: ['不要传非当前网站工作区的快照路径。'],
  usage: ['传 pages/ 下的快照 path；可传 name、overwrite 和 template。'],
  examples: [{ path: "pages/login.json", template: "login" }],
  notes: ['不会重新访问页面。'],
  schema: z.object({
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
    template: z
      .enum(['login', 'search', 'pagination', 'form_submit'])
      .optional()
      .describe(
        parameterDescription({
          description: '预设 recipe 模板。',
          values: [
            'login：登录流程骨架。',
            'search：搜索流程骨架。',
            'pagination：翻页流程骨架。',
            'form_submit：表单提交流程骨架。',
          ],
          notes: ['选定后会在首部插入对应步骤骨架。'],
        })
      ),
  }),
  permissions: ['fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  // helper 会校验 snapshot 路径和当前站点同源。
  execute: browserRecipeArtifacts.generateSkeletonFromSnapshot.bind(browserRecipeArtifacts),
})

/** 读取并预览 recipe skeleton，不执行页面动作。 */
const browserReadRecipeSkeleton = defineBrowserTool<{
  path: string
  inputs?: Record<string, string>
  maxSteps?: number
}>({
  name: 'browser:read_recipe_skeleton',
  role: 'inspect',
  summary: '读取并预览当前网站的 recipe skeleton。',
  suitable: ['需要查看 recipe 输入、可执行步骤和缺失字段。'],
  forbidden: ['不要用它执行页面动作。'],
  usage: ['传 recipes/ 下的 path；可传 inputs 观察步骤是否 ready。'],
  examples: [{ path: "recipes/search.json", maxSteps: 20 }],
  notes: ['只读当前网站工作区 recipes/ 下的文件。'],
  schema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        parameterDescription({
          description: '当前网站浏览器工作区内的 recipe skeleton 路径。',
          usage: ['通常是 recipes/xxx.json。'],
        })
      ),
    inputs: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        parameterDescription({
          description: '预览时使用的 recipe 输入值。',
          usage: ['用于判断哪些步骤 ready、哪些输入缺失。'],
        })
      ),
    maxSteps: z.number().transform((value) => Math.min(50, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最多预览多少个可执行步骤。',
        notes: ['上限 50,超出自动钳制。'],
      })
    ),
  }),
  permissions: ['fs:read'],
  capabilities: BrowserArtifactReadCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  // 只读预览可并发；不会修改页面或写 artifact。
  execute: browserRecipeArtifacts.readSkeleton.bind(browserRecipeArtifacts),
})

/** 执行或 dryRun 预检 recipe skeleton。 */
const browserRunRecipeSkeleton = defineBrowserTool<{
  path: string
  inputs?: Record<string, string>
  variables?: Record<string, string>
  maxSteps?: number
  dryRun?: boolean
  stopOnMiss?: boolean
  saveRun?: boolean
  saveSnapshots?: boolean
  runName?: string
}>({
  name: 'browser:run_recipe_skeleton',
  role: 'edit',
  summary: '执行当前网站的 recipe skeleton。',
  suitable: ['需要按 recipe 顺序执行点击、输入或带 target 的链接跟随步骤。'],
  forbidden: [
      '不要用它运行任意脚本或读取普通 workspace。',
      '不要首次运行新 recipe 时直接跳过 dryRun 预检。',
    ],
  protocol: ['先 dryRun=true 预检；确认目标命中后再 dryRun=false 执行真实页面操作。'],
  usage: ['传 recipes/ 下的 path；按 input.name 提供 inputs。'],
  examples: [{ path: "recipes/search.json", dryRun: true }],
  notes: ['真实执行会点击、输入或提交表单。'],
  schema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        parameterDescription({
          description: '当前网站浏览器工作区内的 recipe skeleton 路径。',
          usage: ['通常是 recipes/xxx.json。'],
        })
      ),
    inputs: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        parameterDescription({
          description: '按 skeleton input.name 传入的字段值。',
        })
      ),
    variables: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        parameterDescription({
          description: '执行时用于替换 inputs 中 %variableName% 占位符的变量值。',
          notes: ['变量值只用于执行，不写入 runs/ 运行记录。'],
        })
      ),
    maxSteps: z.number().transform((value) => Math.min(50, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最多执行多少个可执行步骤。',
        notes: ['上限 50,超出自动钳制。'],
      })
    ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '是否只预检 recipe。',
          notes: ['dryRun=true 不执行页面动作，也不写入 runs/。'],
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
        description: '是否把执行记录保存到当前网站工作区 runs/。',
        notes: ['默认 true。'],
      })
    ),
    saveSnapshots: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '真实执行时是否保存 before/after 页面快照。',
          notes: ['默认 true。'],
        })
      ),
    runName: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '保存 run artifact 时使用的名称。',
      })
    ),
  }),
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  // run helper 负责输入校验、顺序执行、snapshot 和 run record。
  execute: browserRecipeRunner.runSkeleton.bind(browserRecipeRunner),
})

/** 读取历史 recipe 运行记录。 */
const browserReadRecipeRun = defineBrowserTool<{
  path: string
}>({
  name: 'browser:read_recipe_run',
  role: 'inspect',
  summary: '读取当前网站的 recipe 运行记录。',
  suitable: ['需要查看 step 结果、before/after snapshot、缺失输入或 run 元数据。'],
  forbidden: ['不要用它读取 recipe skeleton；recipe 用 browser:read_recipe_skeleton。'],
  usage: ['传 runs/ 下的 path。'],
  examples: [{ path: "runs/search-001.json" }],
  notes: ['只读当前网站工作区 runs/ 下的记录。'],
  schema: z.object({
    path: z.string().min(1).describe(
      parameterDescription({
        description: '当前网站浏览器工作区内的运行记录路径。',
        usage: ['通常是 runs/xxx.json。'],
      })
    ),
  }),
  permissions: ['fs:read'],
  capabilities: BrowserArtifactReadCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  // 只读当前站点 runs/ 下的记录。
  execute: browserRecipeArtifacts.readRun.bind(browserRecipeArtifacts),
})

/** 从历史 run record 中解析 recipePath 并重跑。 */
const browserRerunRecipeFromRun = defineBrowserTool<{
  path: string
  inputs?: Record<string, string>
  variables?: Record<string, string>
  maxSteps?: number
  dryRun?: boolean
  stopOnMiss?: boolean
  saveRun?: boolean
  saveSnapshots?: boolean
  runName?: string
}>({
  name: 'browser:rerun_recipe_from_run',
  role: 'edit',
  summary: '根据历史 run record 重跑对应 recipe。',
  suitable: ['需要复现或修正上一轮 recipe 执行。'],
  forbidden: ['不要假设历史记录保存了敏感输入值。'],
  protocol: ['读取 run 后补齐 inputs；先 dryRun=true 预检，再真实重跑。'],
  usage: ['传 runs/ 下的 path，并按需传 inputs、maxSteps、dryRun。'],
  examples: [{ path: "runs/search-001.json", dryRun: true }],
  notes: ['会校验 run record 与当前网站上下文。'],
  schema: z.object({
    path: z.string().min(1).describe(
      parameterDescription({
        description: '当前网站浏览器工作区内的运行记录路径。',
        usage: ['通常是 runs/xxx.json。'],
      })
    ),
    inputs: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        parameterDescription({
          description: '重跑时按 recipe input.name 传入的字段值。',
        })
      ),
    variables: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        parameterDescription({
          description: '重跑时用于替换 inputs 中 %variableName% 占位符的变量值。',
          notes: ['变量值只用于执行，不复用或写入历史 run。'],
        })
      ),
    maxSteps: z.number().transform((value) => Math.min(50, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最多执行多少个可执行步骤。',
        notes: ['上限 50,超出自动钳制。'],
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
        description: '是否保存新的 run artifact。',
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
        description: '保存新 run artifact 时使用的名称。',
      })
    ),
  }),
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  // 重跑不复用历史输入，调用方必须重新传 inputs。
  execute: browserRecipeArtifacts.rerunFromRun.bind(browserRecipeArtifacts),
})

/** recipe 自动化工具出口。 */
const browserRecipe = defineBrowserTool<z.input<typeof browserRecipeSchema>>({
  name: 'browser:recipe',
  role: 'edit',
  summary: '统一管理当前网站的 browser recipe skeleton 和运行记录。',
  suitable: [
    '需要生成、预览、执行或重跑当前 browser site 的 recipe。',
    '需要读取 recipe skeleton 或历史 run record。',
  ],
  forbidden: [
    '不要用它读取普通 browser 工作区文件；文件和 artifact 读写使用 browser:files。',
    '不要首次运行新 recipe 时直接跳过 dryRun 预检。',
  ],
  protocol: ['真实执行前先 action=run_skeleton dryRun=true 预检；确认目标命中后再执行。'],
  usage: ['传 action 选择 generate/read/run/rerun，再传 path、inputs 或模板参数。'],
  examples: [
    // 从当前页面生成 recipe 草稿
    { action: 'generate_skeleton', template: 'search', name: 'site-search' },
    // 从已存快照生成草稿
    { action: 'generate_skeleton_from_snapshot', path: 'pages/login.json', template: 'login' },
    // 读取草稿步骤
    { action: 'read_skeleton', path: 'recipes/search.json', maxSteps: 20 },
    // 真跑前先 dryRun 预检
    { action: 'run_skeleton', path: 'recipes/search.json', dryRun: true },
    // 确认命中后真实执行并传输入
    { action: 'run_skeleton', path: 'recipes/search.json', inputs: { q: 'VelarOS' } },
    // 读取历史 run record
    { action: 'read_run', path: 'runs/search-001.json' },
    // 基于历史 run 重跑（须重新传 inputs）
    { action: 'rerun_from_run', path: 'runs/search-001.json', inputs: { q: 'VelarOS' } },
  ],
  notes: ['这是 browser recipe 的唯一公开入口；内部仍按 action 复用 skeleton、run 和 rerun 实现。'],
  schema: browserRecipeSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    const parsed = parseBrowserRecipeInput(input)

    switch (parsed.action) {
      case 'generate_skeleton':
        return browserGenerateRecipeSkeleton.execute(
          {
            name: parsed.name,
            saveSnapshot: parsed.saveSnapshot,
            snapshotName: parsed.snapshotName,
            overwriteSnapshot: parsed.overwriteSnapshot,
            maxTextChars: parsed.maxTextChars,
            overwrite: parsed.overwrite,
            template: parsed.template,
          },
          ctx
        )
      case 'generate_skeleton_from_snapshot':
        return browserGenerateRecipeSkeletonFromSnapshot.execute(
          {
            path: parsed.path,
            name: parsed.name,
            overwrite: parsed.overwrite,
            template: parsed.template,
          },
          ctx
        )
      case 'read_skeleton':
        return browserReadRecipeSkeleton.execute(
          {
            path: parsed.path,
            inputs: parsed.inputs,
            maxSteps: parsed.maxSteps,
          },
          ctx
        )
      case 'run_skeleton':
        return browserRunRecipeSkeleton.execute(
          {
            path: parsed.path,
            inputs: parsed.inputs,
            variables: parsed.variables,
            maxSteps: parsed.maxSteps,
            dryRun: parsed.dryRun,
            stopOnMiss: parsed.stopOnMiss,
            saveRun: parsed.saveRun,
            saveSnapshots: parsed.saveSnapshots,
            runName: parsed.runName,
          },
          ctx
        )
      case 'read_run':
        return browserReadRecipeRun.execute(
          {
            path: parsed.path,
          },
          ctx
        )
      case 'rerun_from_run':
        return browserRerunRecipeFromRun.execute(
          {
            path: parsed.path,
            inputs: parsed.inputs,
            maxSteps: parsed.maxSteps,
            dryRun: parsed.dryRun,
            stopOnMiss: parsed.stopOnMiss,
            saveRun: parsed.saveRun,
            saveSnapshots: parsed.saveSnapshots,
            runName: parsed.runName,
          },
          ctx
        )
      default:
        parsed satisfies never
        throw new AppError('VALIDATION', 'Unsupported browser:recipe action.')
    }
  },
})

const browserRecipeTools = {
  'browser:recipe': browserRecipe,
}
export { browserRecipeTools }
