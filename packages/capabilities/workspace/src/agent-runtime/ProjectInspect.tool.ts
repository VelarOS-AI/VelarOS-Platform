import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'

import { runWithDirectory } from './Helpers'
import {
  buildJsTsProjectProfile,
  buildJsTsProjectProfileForRoot,
  resolveSandboxSourceProjectRoot,
} from './ProjectInspect'
import { defineWorkspaceVelaTool } from './workspaceToolMiddleware'

/** 获取当前项目类型、脚本和包管理器等基础信息。 */
const getProjectInfo = defineWorkspaceVelaTool<{ cwd?: string }>({
  name: 'get_project_info',
  role: 'inspect',
  category: 'workspace-inspect',
  summary: '检查当前工作区的通用工程信息。',
  suitable: ['需要了解项目类型、标记文件、包管理器、脚本或 JS/TS 配置画像。'],
  forbidden: ['不要用它读取具体源码内容。'],
  usage: ['可传 cwd 检查 monorepo 子项目。'],
  examples: [
    // 当前工作区
    {},
    // monorepo 子包
    { cwd: 'packages/app' },
  ],
  notes: [
    '返回根目录、项目类型和常用脚本摘要。',
    'monorepo 根无 package.json 时部分字段可能为空；传 cwd 到子包。',
  ],
  schema: z.object({
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '项目目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
  }),
  permissions: ['fs:read'],
  isConcurrencySafe: () => true,
  execute: async ({ cwd }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const sourceProjectRoot = resolveSandboxSourceProjectRoot(ctx, cwd)
    if (sourceProjectRoot) {
      const info = await ctx.workspace.getProjectInfoForRoot(sourceProjectRoot)
      return {
        ...info,
        rootPath: sourceProjectRoot,
        executionRoot: ctx.workspace.getRootPath(),
        sourceRoot: ctx.workspaceSandbox?.current.sourceRoot,
        jsTs: await buildJsTsProjectProfileForRoot(ctx, sourceProjectRoot, info.packageManager),
      }
    }

    // 项目信息按 cwd 视角检测，可用于 monorepo 子项目。
    return runWithDirectory(ctx, cwd, async () => {
      const info = await ctx.workspace.getProjectInfo()
      return {
        ...info,
        rootPath: ctx.workspace.getRootPath(),
        jsTs: await buildJsTsProjectProfile(ctx, info.packageManager),
      }
    })
  },
})

/** 项目检查类工具出口。 */
const codingProjectInspectTools = {
  get_project_info: getProjectInfo,
}
export { codingProjectInspectTools }
