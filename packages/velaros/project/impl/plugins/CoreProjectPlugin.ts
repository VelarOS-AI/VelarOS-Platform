/**
 * 内核自带的插件：`CoreProjectPlugin` 与整个进程共用的 `corePlugin`，实现注入面的 `ProjectPlugin`（contract/requires.ts）。
 * 装五种文件 adapter（纯文本、JSON、Markdown、通用代码、JS/TS）、四种补丁策略（JSON Patch、JS/TS 符号、文本、预编译正文）
 * 和两个校验器（事务范围、后置条件）。内核创建时默认先装它，宿主可以关掉。
 */

import { ProjectPackageVersion } from '../../contract/constants.js'
import type { ProjectPlugin, ProjectPluginContext } from '../../contract/requires.js'
import { CodeFileAdapterFactory } from '../adapters/CodeFileAdapterFactory.js'
import { JsonFileAdapterFactory } from '../adapters/JsonFileAdapterFactory.js'
import { JsTsFileAdapterFactory } from '../adapters/JsTsFileAdapterFactory.js'
import { MarkdownFileAdapterFactory } from '../adapters/MarkdownFileAdapterFactory.js'
import { TextFileAdapterFactory } from '../adapters/TextFileAdapterFactory.js'
import { JsonPatchStrategy } from '../strategies/JsonPatchStrategy.js'
import { JsTsPatchStrategy } from '../strategies/JsTsPatchStrategy.js'
import { PreparedContentStrategy } from '../strategies/PreparedContentStrategy.js'
import { TextPatchStrategy } from '../strategies/TextPatchStrategy.js'

import { PostconditionValidator } from './PostconditionValidator.js'
import { ScopeValidator } from './ScopeValidator.js'

export class CoreProjectPlugin implements ProjectPlugin {
  /** 核心 JS/TS adapter 的身份；TypeScript 插件以更高优先级另注册一份。 */
  private static readonly JsTsAdapterIdentity = Object.freeze({
    factoryId: 'jsts.factory',
    adapterId: 'jsts.adapter',
    priority: 80,
    checkId: 'jsts.syntax',
  })
  /** 核心 JS/TS 补丁策略的身份。 */
  private static readonly JsTsStrategyIdentity = Object.freeze({ id: 'jsts.patch', priority: 90 })

  public readonly name = '@velaros-ai/project/core'
  public readonly version = ProjectPackageVersion

  public setup(ctx: ProjectPluginContext): void {
    ctx.registerAdapterFactory(new TextFileAdapterFactory())
    ctx.registerAdapterFactory(new JsonFileAdapterFactory())
    ctx.registerAdapterFactory(new MarkdownFileAdapterFactory())
    ctx.registerAdapterFactory(new CodeFileAdapterFactory())
    ctx.registerAdapterFactory(new JsTsFileAdapterFactory(CoreProjectPlugin.JsTsAdapterIdentity))
    ctx.registerPatchStrategy(new JsonPatchStrategy())
    ctx.registerPatchStrategy(new JsTsPatchStrategy(CoreProjectPlugin.JsTsStrategyIdentity))
    ctx.registerPatchStrategy(new TextPatchStrategy())
    ctx.registerPatchStrategy(new PreparedContentStrategy())
    ctx.registerValidator(new ScopeValidator())
    ctx.registerValidator(new PostconditionValidator())
  }
}

/** 整个进程共用的核心插件；每次 setup 都给那个内核装一套新的 adapter、策略与校验器实例。 */
export const corePlugin: ProjectPlugin = new CoreProjectPlugin()
