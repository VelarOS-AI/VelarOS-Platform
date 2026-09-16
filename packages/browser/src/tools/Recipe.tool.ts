import type { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'

import { browserRecipeSchema, parseBrowserRecipeInput } from './BrowserRecipeSchema'
import { BrowserControlCapability } from './Capabilities'
import { browserRecipeArtifacts } from './RecipeArtifacts'
import { browserRecipeRunner } from './RecipeRun'
import { defineBrowserTool } from './Types'

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
  usage: [
    '传 action 选择 generate/read/run/rerun，再传 path、inputs 或模板参数。',
    'rerun_from_run 不沿用历史 inputs，必须重新传。',
  ],
  examples: [
    // 从当前页面生成 recipe 草稿
    { action: 'generate_skeleton', template: 'search', name: 'site-search' },
    // 读取草稿步骤
    { action: 'read_skeleton', path: 'recipes/search.json', maxSteps: 20 },
    // 真跑前先 dryRun 预检
    { action: 'run_skeleton', path: 'recipes/search.json', dryRun: true },
    // 确认命中后真实执行并传输入
    { action: 'run_skeleton', path: 'recipes/search.json', inputs: { q: 'VelarOS' } },
    // 基于历史 run 重跑（须重新传 inputs）
    { action: 'rerun_from_run', path: 'runs/search-001.json', inputs: { q: 'VelarOS' } },
  ],
  notes: ['这是 browser recipe 的唯一公开入口；内部仍按 action 复用 skeleton、run 和 rerun 实现。'],
  usageSkillId: 'browser-automation-recipes',
  schema: browserRecipeSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    const parsed = parseBrowserRecipeInput(input)

    switch (parsed.action) {
      case 'generate_skeleton':
        return browserRecipeArtifacts.generateSkeleton(
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
        return browserRecipeArtifacts.generateSkeletonFromSnapshot(
          {
            path: parsed.path,
            name: parsed.name,
            overwrite: parsed.overwrite,
            template: parsed.template,
          },
          ctx
        )
      case 'read_skeleton':
        return browserRecipeArtifacts.readSkeleton(
          {
            path: parsed.path,
            inputs: parsed.inputs,
            maxSteps: parsed.maxSteps,
          },
          ctx
        )
      case 'run_skeleton':
        return browserRecipeRunner.runSkeleton(
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
        return browserRecipeArtifacts.readRun(
          {
            path: parsed.path,
          },
          ctx
        )
      case 'rerun_from_run':
        return browserRecipeArtifacts.rerunFromRun(
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
