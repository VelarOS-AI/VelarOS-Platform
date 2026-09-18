/**
 * 编辑规划的两件准备：把一次 edit 步骤里模型给的路径换成相对项目根的写法（钳在项目内），
 * 以及给规划器的读取端口（凭 fileRef 取已交出的视图、看一个路径的当前版本、为 recode 读整份正文与磁盘编码）。
 */

import { isString } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type { ProjectPlannerResolver } from '../../types/editing.js'
import type { ProjectEditStep } from '../../types/files.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

import { scopeListPatterns } from './file-reads.js'
import { resolveFileRef } from './file-refs.js'
import { projectRelativePath } from './ports.js'

/** 把步骤里的路径（create 与 move 的目标、path 来源、recode 的路径）换成相对项目根的写法；fileRef、sourceRef 原样留着，解析时再核对属于这个项目。 */
export async function locateEditSteps(steps: readonly ProjectEditStep[], ctx: ProjectOperationContext): Promise<ProjectEditStep[]> {
  const located: ProjectEditStep[] = []
  for (const step of steps) {
    switch (step.action) {
      case 'create':
        located.push({ ...step, path: await projectRelativePath(ctx, step.path) })
        break
      case 'recode': {
        const paths: string[] = []
        for (const path of step.paths) paths.push(await projectRelativePath(ctx, path))
        located.push({ ...step, paths })
        break
      }
      default: {
        const shaped = { ...step } as ProjectEditStep & { path?: string; to?: string }
        if ('path' in step && isString(step.path)) shaped.path = await projectRelativePath(ctx, step.path)
        if (step.action === 'move') shaped.to = await projectRelativePath(ctx, step.to)
        located.push(shaped)
      }
    }
  }
  return located
}

/** 给编辑规划器的读取端口：凭 fileRef 取已交出的视图（正文变了按过期拒绝）、看一个路径的当前版本、为 recode 读整份正文与磁盘编码。 */
export function projectPlannerResolver(ctx: ProjectOperationContext): ProjectPlannerResolver {
  return {
    resolveFileRef: (ref) => resolveFileRef(ctx, ref),
    readPath: async (path) => {
      ctx.abortSignal.throwIfAborted()
      const kernel = await ctx.project.kernel()
      const result = await kernel.read({ path, maxChars: 1 })
      if (!result.snapshot.revision) throw new ProjectError('BASE_REVISION_MISMATCH', '路径没有可核对的版本。', { path })
      if (result.snapshot.isDirectory || result.snapshot.isBinary) throw new ProjectError('NOT_SUPPORTED', '文件动作只收普通文本文件的路径；目录和二进制文件用命令处理。', { path })
      return { path: result.snapshot.path, revision: result.snapshot.revision, exists: result.snapshot.exists }
    },
    readText: async (path) => {
      ctx.abortSignal.throwIfAborted()
      const kernel = await ctx.project.kernel()
      const result = await kernel.read({ path, maxChars: ProjectTuning.agent.fullReadChars })
      if (!result.snapshot.exists) throw new ProjectError('TARGET_NOT_FOUND', `${path} 不存在。`, { path }, '先 list 出准确的路径再转换。')
      if (result.snapshot.isDirectory) throw new ProjectError('NOT_SUPPORTED', `${path} 是目录；recode 只收文件路径。`, { path }, '先 list 出目录里的文件（include 写 glob），再把文件路径交给 recode。')
      if (result.snapshot.isBinary) throw new ProjectError('NOT_SUPPORTED', `${path} 是二进制文件，没有可转换的文本。`, { path }, 'recode 只转换文本文件：把这条路径去掉再提交。')
      if (!result.snapshot.revision || result.truncated || result.hasMore || !isString(result.content)) {
        throw new ProjectError('NOT_SUPPORTED', `${path} 的正文读不全，不能转换编码。`, { path })
      }
      const stat = await kernel.stat({ path: result.snapshot.path })
      if (stat.revision !== result.snapshot.revision) throw new ProjectError('BASE_REVISION_MISMATCH', `${path} 在读取期间变了。`, { path })
      return { path: result.snapshot.path, revision: result.snapshot.revision, exists: true, content: result.content, textEncoding: stat.textEncoding ?? 'utf8' }
    },
    listPaths: async (pattern) => {
      ctx.abortSignal.throwIfAborted()
      const kernel = await ctx.project.kernel()
      // 和 list 同一套写法：不带 / 的按文件名、任意深度都算，带 / 的从项目根起算。
      const include = scopeListPatterns(ctx.project.getRootPath(), '', [pattern])
      const entries = await kernel.listFiles({ include, recursive: true, maxDepth: ProjectFileLimits.listDepth, maxFiles: ProjectFileLimits.listEntries })
      return entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
    },
  }
}
