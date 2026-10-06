import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppError } from '@velaros-ai/core/error'

import type { SkillsOperationContext } from '../contract/requires.js'
import type {
  SkillDirectoryInput,
  SkillGuide,
  SkillGuideInput,
  SkillInstallRequest,
  SkillLoaded,
  SkillManifest,
  SkillNameInput,
  SkillSummary,
} from '../types/skills.js'
import {
  parseSkillInput,
  resolveSkillSource,
  SkillOperationInputs,
  skillSummary,
} from '../utils/operations.js'
import { containedSkillPath, readSkillText } from '../utils/package-io.js'

/** @AgentView Skill 开发、管理与按需加载。guide 查询内置开发规范和示例；list 查询安装状态；load 读取本轮可用 Skill。
 * 标准 npm 直接 import。安装只加入本机库；宿主按会话选择加载的 Skill 和能力。卸载和升级立即阻止旧代次后续的能力调用。
 */
export interface SkillsOperationsApi {
  /** @AgentView 查询内置文档，默认 authoring；management 说明生命周期，example 返回可用的示例文件。
   * @OperationEffect none
   */
  guide(input: Optional<SkillGuideInput>, ctx: SkillsOperationContext): Promise<SkillGuide>
  /** @AgentView 列出已安装 Skill，包含本轮可加载状态。正文按需 load。
   * @OperationEffect none
   */
  list(ctx: SkillsOperationContext): Promise<SkillSummary[]>
  /** @AgentView 按名称加载本轮可用 Skill 的完整说明和资源目录。额外资源用 Node 读取。
   * @OperationEffect none
   */
  load(input: SkillNameInput, ctx: SkillsOperationContext): Promise<SkillLoaded>
  /** @AgentView 静态校验源目录、清单、Node 兼容性与能力声明，不执行包代码或下载依赖。安装验证依赖，会话加载验证组合冲突。
   * @OperationEffect none
   */
  validate(input: SkillDirectoryInput, ctx: SkillsOperationContext): Promise<SkillManifest>
  /** @AgentView 从本地目录安装或升级，发布前经宿主确认。默认禁用依赖脚本。安装完成后由会话选择加载。
   * @OperationEffect write
   * @OperationModes execute
   */
  install(input: SkillInstallRequest, ctx: SkillsOperationContext): Promise<SkillSummary>
  /** @AgentView 卸载已安装 Skill，发布前经宿主确认。仍被执行或后台任务使用的文件保留到租约释放。
   * @OperationEffect write
   * @OperationModes execute
   */
  remove(input: SkillNameInput, ctx: SkillsOperationContext): Promise<void>
}

/** 统一模型入口；文件创建与标准依赖使用继续由原生 Node 承担。 */
export class SkillsOperations implements SkillsOperationsApi {
  public async guide(
    input: Optional<SkillGuideInput>,
    ctx: SkillsOperationContext
  ): Promise<SkillGuide> {
    ctx.abortSignal.throwIfAborted()
    const { topic = 'authoring' } = parseSkillInput(SkillOperationInputs.guide, input ?? {})
    const content = await readSkillText(
      fileURLToPath(new URL(`../resources/${topic}.md`, import.meta.url))
    )
    const files: Record<string, string> = {}
    if (topic === 'example') {
      files['SKILL.md'] = await readSkillText(
        fileURLToPath(new URL('../resources/guided-review.md', import.meta.url))
      )
    }
    return { content, files }
  }

  public async list(ctx: SkillsOperationContext): Promise<SkillSummary[]> {
    ctx.abortSignal.throwIfAborted()
    return (await ctx.registry.list()).map((item) => skillSummary(item, ctx.lease.skills))
  }

  public async load(input: SkillNameInput, ctx: SkillsOperationContext): Promise<SkillLoaded> {
    ctx.abortSignal.throwIfAborted()
    const { name } = parseSkillInput(SkillOperationInputs.name, input)
    const current = (await ctx.registry.list()).find((item) => item.manifest.name === name)
    if (!current) throw new AppError('NOT_FOUND', `Skill 未安装：${name}`)
    const selected = ctx.lease.skills.find((item) => item.generation === current.generation)
    if (!selected)
      throw new AppError('UNAVAILABLE', `Skill ${name} 未被本轮选择；请在会话中选择后加载`)
    const file = selected.manifest.contribution.instructions
    const instructions = file
      ? await readSkillText(
          await containedSkillPath(selected.directory, join(selected.directory, file))
        )
      : null
    return {
      skill: { ...skillSummary(current, ctx.lease.skills), grants: selected.grants },
      directory: selected.directory,
      instructions,
    }
  }

  public async validate(
    input: SkillDirectoryInput,
    ctx: SkillsOperationContext
  ): Promise<SkillManifest> {
    ctx.abortSignal.throwIfAborted()
    const { directory } = parseSkillInput(SkillOperationInputs.directory, input)
    return ctx.registry.validate(
      await resolveSkillSource(directory, ctx.cwd, ctx.sourceScope),
      ctx.abortSignal
    )
  }

  public async install(
    input: SkillInstallRequest,
    ctx: SkillsOperationContext
  ): Promise<SkillSummary> {
    ctx.recordEffect('none')
    ctx.abortSignal.throwIfAborted()
    const parsed = parseSkillInput(SkillOperationInputs.install, input)
    const request = {
      ...parsed,
      directory: await resolveSkillSource(parsed.directory, ctx.cwd, ctx.sourceScope),
    }
    await ctx.registry.validate(request.directory, ctx.abortSignal)
    await ctx.authorize({ operation: 'install', request }, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    ctx.recordEffect('unknown')
    const record = await ctx.registry.install(request, ctx.abortSignal)
    ctx.recordEffect('committed')
    return skillSummary(record, ctx.lease.skills)
  }

  public async remove(input: SkillNameInput, ctx: SkillsOperationContext): Promise<void> {
    ctx.recordEffect('none')
    ctx.abortSignal.throwIfAborted()
    const request = parseSkillInput(SkillOperationInputs.name, input)
    if (!(await ctx.registry.list()).some((item) => item.manifest.name === request.name))
      throw new AppError('NOT_FOUND', `Skill 未安装：${request.name}`)
    await ctx.authorize({ operation: 'remove', request }, ctx.abortSignal)
    ctx.abortSignal.throwIfAborted()
    await ctx.registry.remove(request.name)
    ctx.recordEffect('committed')
  }
}

/** 所有空间复用同一套按需操作。 */
export const skillsOperations: SkillsOperationsApi = new SkillsOperations()
