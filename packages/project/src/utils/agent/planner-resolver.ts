import { isString } from '@velaros-ai/core'

import type { ProjectToolContext } from '../../contract/requires'
import type { ProjectPlannerResolver } from '../../types/editing'
import { ProjectError } from '../errors'
import { ProjectTuning } from '../tuning.js'

import { resolveProjectFileRef } from './file-refs'

/** 给编辑计划编译器的读取端口：按 fileRef 取已显示的视图（正文变了按过期拒绝）、看一个路径的当前版本、为编码转换读整份正文与磁盘编码。 */
export function projectPlannerResolver(context: ProjectToolContext): ProjectPlannerResolver {
  return {
    resolveFileRef: (ref) => resolveProjectFileRef(context, ref),
    readPath: async (path) => {
      context.abortSignal.throwIfAborted()
      const kernel = await context.project.kernel()
      const result = await kernel.read({ path, maxChars: 1 })
      if (!result.snapshot.revision)
        throw new ProjectError('BASE_REVISION_MISMATCH', '路径没有可验证的版本。', { path })
      if (result.snapshot.isDirectory || result.snapshot.isBinary)
        throw new ProjectError('NOT_SUPPORTED', '文件操作需要普通文本文件路径。', { path })
      return {
        path: result.snapshot.path,
        revision: result.snapshot.revision,
        exists: result.snapshot.exists,
      }
    },
    readText: async (path) => {
      context.abortSignal.throwIfAborted()
      const kernel = await context.project.kernel()
      const result = await kernel.read({ path, maxChars: ProjectTuning.agent.fullReadChars })
      if (!result.snapshot.exists)
        throw new ProjectError('TARGET_NOT_FOUND', '文件不存在。', { path })
      if (result.snapshot.isDirectory || result.snapshot.isBinary)
        throw new ProjectError('NOT_SUPPORTED', '编码转换需要普通文本文件路径。', { path })
      if (!result.snapshot.revision || result.redacted || result.truncated || result.hasMore || !isString(result.content))
        throw new ProjectError('NOT_SUPPORTED', '文件正文无法完整读取，不能转换编码。', { path })
      const stat = await kernel.stat({ path: result.snapshot.path })
      if (stat.revision !== result.snapshot.revision)
        throw new ProjectError('BASE_REVISION_MISMATCH', '文件在读取期间发生变化。', { path })
      return {
        path: result.snapshot.path,
        revision: result.snapshot.revision,
        exists: true,
        content: result.content,
        textEncoding: stat.textEncoding ?? 'utf8',
      }
    },
  }
}
