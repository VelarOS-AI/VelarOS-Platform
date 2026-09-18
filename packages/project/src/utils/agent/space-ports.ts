/**
 * 项目空间给两件共用能力装的端口：`velar:images` 与 `velar:sandbox`。都不带状态，按这一次调用的上下文现装；
 * `velar:shell` 的端口要用项目资源门（带状态），留在 `impl/ProjectSpace.ts`。
 */

import { AppError } from '@velaros-ai/core/error'
import type { ImageSpacePort } from '@velaros-ai/velar/images'
import type { SandboxSurfacePort } from '@velaros-ai/velar/sandbox'

import type { ProjectCallContext } from '../../contract/requires.js'

import { redactCommandOutput } from './execution.js'
import { assertSandboxApplyWritable, genericFailure, insideProject, projectRelativePath } from './ports.js'

/**
 * `velar:images` 的项目端口：只看项目里的图（经符号链接指到项目外的也不行），而且先过项目的读取策略（拒读名单、宿主可见范围）；
 * 裁图缩图用宿主给的能力，宿主没给就明说做不了。
 */
export function projectImagePort(ctx: ProjectCallContext): ImageSpacePort {
  const port: ImageSpacePort = {
    locate: async (requested) => {
      const path = await projectRelativePath(ctx, requested)
      const kernel = await ctx.project.kernel()
      // 看图的码是通用的那一套（PERMISSION、NOT_FOUND……），不是项目的原因码。
      const stat = await kernel.stat({ path }).catch((error: unknown) => {
        throw genericFailure(error)
      })
      return { target: stat.absolutePath, shown: path }
    },
  }
  if (ctx.project.resizeImage) port.resizeImage = ctx.project.resizeImage
  return port
}

/**
 * `velar:sandbox` 的项目端口：只镜像项目内的目录，镜像里的命令走宿主的沙箱执行器（出不了镜像），
 * 落回前先把每条路径过一遍项目的写授权、再过一次项目的修改授权——两件都排在问用户之前。
 */
export function projectSandboxPort(ctx: ProjectCallContext): SandboxSurfacePort {
  const port = () => {
    const sandbox = ctx.project.sandbox
    if (!sandbox) {
      throw new AppError('UNAVAILABLE', '这台机器上没有演练沙箱：要改一批文件直接用 velar:project 的 edit，要跑脚本用 velar:shell 的 run')
    }
    return sandbox
  }
  const source = async (requested: Optional<string>) => (await insideProject(ctx.project.getRootPath(), requested ?? '.', '沙箱的源目录')).resolved
  return {
    createSandbox: async (options) => port().createSandbox({ ...options, source: await source(options?.source) }),
    diffSandbox: (options) => port().diffSandbox(options),
    applySandbox: (options) => port().applySandbox(options),
    discardSandbox: (sandboxId) => port().discardSandbox(sandboxId),
    resolveSource: (requested) => source(requested),
    runInSandbox: async (options, abortSignal) => {
      const result = await port().runInSandbox(options, abortSignal ?? ctx.abortSignal)
      const shaped = await redactCommandOutput(ctx, result)
      return { exitCode: shaped.exitCode, stdout: shaped.stdout, stderr: shaped.stderr, durationMs: shaped.durationMs, timedOut: shaped.timedOut, truncated: shaped.truncated, success: shaped.success }
    },
    reviewApply: async (selection) => {
      await assertSandboxApplyWritable(ctx, [...selection.created, ...selection.modified, ...selection.deleted])
      const decision = await ctx.project.prepareMutation({ operation: '把演练沙箱的改动落回项目' })
      if (!decision.approved) throw new AppError('PERMISSION', decision.message)
    },
    applyPolicy: () => ({
      targetLabel: '当前项目',
      closingNote: '删除和覆盖不经过项目的撤销账本；落回前会核对这些文件自建沙箱以来没被别人改过，改过就整批不落。',
      riskScope: 'project-sandbox:apply',
    }),
  }
}
