/**
 * 项目空间给三件共用能力装的端口里不带状态的那部分：`velar:images` 与 `velar:sandbox` 的端口按这一次调用的上下文现装，
 * 命令输出脱敏、路径钳在项目内、沙箱落回前的写治理核对、项目内核的拒绝翻成通用码。
 * `velar:shell` 的端口要用项目资源门（带状态），留在 `impl/ProjectSpace.ts`。
 */

import { resolve } from 'node:path'

import { isEmpty, isNull, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { currentPlatform } from '@velaros-ai/platform'
import type { ImageSpacePort } from '@velaros-ai/velar/images'
import type { SandboxSurfacePort } from '@velaros-ai/velar/sandbox'
import type { ShellCommandResult } from '@velaros-ai/velar/shell/contracts'

import type { ProjectCallContext } from '../contract/requires.js'

import { ProjectSpaceTuning } from './tuning.js'

/** 项目内核的原因码对应到通用码：看图说的是跨空间共用的那一套码（PERMISSION、NOT_FOUND……）。 */
const AppCodeOfReason: Readonly<Record<string, string>> = Object.freeze({
  PERMISSION_DENIED: 'PERMISSION',
  TARGET_NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'VALIDATION',
  NOT_SUPPORTED: 'VALIDATION',
})

/**
 * 把项目内核抛的拒绝翻成通用码的错误：内核的错误带 `reason`（原因码）、`message` 与可选的 `suggestedNextAction`，按字段认，不认类；
 * 下一步照写进 message。认不出的错误原样抛回去。
 */
export function genericFailure(error: unknown): unknown {
  const failure = error as { reason?: unknown; message?: unknown; suggestedNextAction?: unknown }
  if (!isString(failure?.reason) || !isString(failure.message)) return error
  const next = isString(failure.suggestedNextAction) ? `\n下一步：${failure.suggestedNextAction}` : ''
  return new AppError(AppCodeOfReason[failure.reason] ?? 'VALIDATION', `${failure.message}${next}`, error)
}

/**
 * 把模型给的路径钳在项目之内，返回解析后的绝对路径。判定按**真实路径**算：只看字面时，
 * 项目里一个指向项目外的链接就能把读写引到项目外面去。
 */
export async function insideProject(root: string, requested: string, what: '文件' | '工作目录' | '沙箱的源目录'): Promise<string> {
  const resolved = resolve(root, requested)
  const inside = currentPlatform.isPathTextInside(await resolveRealPath(resolved), await resolveRealPath(root), { caseSensitive: true })
  if (!inside) {
    throw new AppError(
      'PERMISSION',
      `${what}必须在当前项目之内：${requested}（经符号链接指到项目外的也不行）；项目空间只碰项目里的东西，要碰外面的换系统空间`,
    )
  }
  return resolved
}

/**
 * 把模型给的文件路径定到项目里，交回相对项目根的写法（`/` 分隔，项目根本身是空串）：越出项目（含经符号链接指到外面的）抛 PERMISSION。
 * 项目根自己可能是符号链接（macOS 的 /var 就是 /private/var），模型给的绝对路径两种写法都认。
 */
async function projectRelativePath(ctx: ProjectCallContext, requested: string): Promise<string> {
  const root = resolve(ctx.project.getRootPath())
  const resolved = await insideProject(root, requested, '文件')
  for (const base of [root, await resolveRealPath(root)]) {
    const relative = currentPlatform.relativePathTextInside(resolved, base, { caseSensitive: true })
    if (!isNull(relative)) return relative === '.' ? '' : relative
  }
  return resolved
}

/**
 * 命令输出交给程序之前过一遍项目的脱敏后端：跑命令与在镜像里跑命令用同一条路，
 * 不然「在沙箱里 cat 一个私钥」就成了绕开项目读取治理的后门。宿主没有脱敏后端时原样返回。
 */
export async function redactCommandOutput<T>(ctx: ProjectCallContext, result: T): Promise<T> {
  const output = result as Partial<ShellCommandResult>
  if (!isString(output?.stdout) && !isString(output?.stderr)) return result
  const kernel = await ctx.project.kernel()
  const stdout = isString(output.stdout) ? (await kernel.redactText({ content: output.stdout })).content : output.stdout
  const stderr = isString(output.stderr) ? (await kernel.redactText({ content: output.stderr })).content : output.stderr
  return { ...result, stdout, stderr }
}

/**
 * 落回前把三列里的每条路径过一遍项目的写授权（越界、writeDeny、宿主可见范围、受保护文件、生成文件）。
 * 有不许写的就在问用户之前整批拒绝：沙箱落回不经事务链，这里不拦就等于给了一条绕开写治理的路。
 */
async function assertSandboxApplyWritable(ctx: ProjectCallContext, paths: readonly string[]): Promise<void> {
  if (isEmpty(paths)) return
  const kernel = await ctx.project.kernel()
  const blocked = (await kernel.authorizeWrites(paths)).filter((decision) => !decision.allowed)
  if (isEmpty(blocked)) return
  const listed = blocked.slice(0, ProjectSpaceTuning.reportedBlockedPaths).map((decision) => `${decision.path}（${decision.reason}）`)
  const rest = blocked.length > listed.length ? `，另有 ${blocked.length - listed.length} 条` : ''
  throw new AppError('PERMISSION', `这些路径项目不许写，整批没落：${listed.join('、')}${rest}。用 paths 点名要落的文件、把它们去掉再 apply`)
}

/**
 * `velar:images` 的项目端口：只看项目里的图（经符号链接指到项目外的也不行），而且先过项目的读取策略（拒读名单、宿主可见范围）；
 * 裁图缩图用宿主给的能力，宿主没给就明说做不了。
 */
export function projectImagePort(ctx: ProjectCallContext): ImageSpacePort {
  const port: ImageSpacePort = {
    locate: async (requested) => {
      const path = await projectRelativePath(ctx, requested)
      const kernel = await ctx.project.kernel()
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
  const source = (requested: Optional<string>) => insideProject(ctx.project.getRootPath(), requested ?? '.', '沙箱的源目录')
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
