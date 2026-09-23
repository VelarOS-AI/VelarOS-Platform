/**
 * TypeScript 插件：`TypeScriptProjectPlugin` 与根入口交出去的工厂 `typescriptPlugin`，实现注入面的 `ProjectPlugin`（contract/requires.ts）。
 * 以更高优先级再装一份 JS/TS adapter 与符号补丁策略（与核心同一实现，只换身份），默认连 JS/TS 语法校验器一起装。
 */

import { ProjectPackageVersion } from '../../contract/constants.js'
import type { ProjectPlugin, ProjectPluginContext } from '../../contract/requires.js'
import type { TypeScriptPluginOptions } from '../../types/plugins.js'
import { JsTsFileAdapterFactory } from '../adapters/JsTsFileAdapterFactory.js'
import { JsTsPatchStrategy } from '../strategies/JsTsPatchStrategy.js'

import { TypeScriptSyntaxValidator } from './TypeScriptSyntaxValidator.js'

export class TypeScriptProjectPlugin implements ProjectPlugin {
  /** 本插件的 JS/TS adapter 身份：优先级高于核心那份，语法检查项叫 typescript.syntax。 */
  private static readonly AdapterIdentity = Object.freeze({
    factoryId: 'velaros.typescript.factory',
    adapterId: 'velaros.typescript.ast',
    priority: 100,
    checkId: 'typescript.syntax',
  })
  /** 本插件的 JS/TS 补丁策略身份：优先级高于核心那份。 */
  private static readonly StrategyIdentity = Object.freeze({
    id: 'velaros.typescript.symbol-patch',
    priority: 100,
  })

  public readonly name = '@velaros-ai/project-typescript'
  public readonly version = ProjectPackageVersion

  public constructor(private readonly options: TypeScriptPluginOptions) {}

  public setup(ctx: ProjectPluginContext): void {
    ctx.registerAdapterFactory(new JsTsFileAdapterFactory(TypeScriptProjectPlugin.AdapterIdentity))
    ctx.registerPatchStrategy(new JsTsPatchStrategy(TypeScriptProjectPlugin.StrategyIdentity))
    if (this.options.syntaxValidator ?? true) ctx.registerValidator(new TypeScriptSyntaxValidator())
  }
}

/** 宿主装 TypeScript 插件用的工厂：`createProjectKernel({ plugins: [typescriptPlugin()] })`；syntaxValidator 为 false 时不装语法校验器。 */
export function typescriptPlugin(options: TypeScriptPluginOptions = {}): ProjectPlugin {
  return new TypeScriptProjectPlugin(options)
}
