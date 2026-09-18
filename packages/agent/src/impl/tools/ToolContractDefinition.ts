/**
 * 造「定义本空间工具」的那一行：类别、契约版本与入参复用信封一次填好，交给定义工具的唯一流水线
 * （`utils/toolkit/define-tool-contract.ts`：断言身份、校验示例、编译说明并过两道长度闸）。
 * 接口 `ToolContractDefinitionApi` 在本文件的类上方；整个进程一份 `toolContracts`。
 */

import { AppError } from '@velaros-ai/core/error'

import type { ToolCategoryId, ToolPermission } from '../../types/agent.js'
import type {
  DefineToolRuntimeSpecInput,
  ToolContractExecute,
  ToolContractRuntimeSpec,
  ToolDefiner,
  ToolDefinerOptions,
} from '../../types/toolkit.js'
import { defineToolRuntimeSpec } from '../../utils/toolkit/define-tool-contract'

/**
 * 写工具的一方定义工具的入口，实例是 `toolContracts`。
 *
 * 定义期会抛错的三件事都在定义流水线里：断言 name 是 canonical 工具 id、校验示例能过工具自己的 schema、
 * 编译说明并过硬上限与软预算两道闸——任一不过就直接抛，坏工具进不了注册表。
 */
export interface ToolContractDefinitionApi {
  /**
   * 造一个「定义本空间工具」的函数：类别按名查表或固定填上，契约版本与入参复用信封一次配好，
   * 各空间只保留一行 `const defineXTool = toolContracts.createDefiner(…)`，不再各写一份同构的壳子。
   * 只在真的改了 schema 或 execute 时才返回新对象（并冻结），否则原样交出定义结果。
   */
  createDefiner<TContext>(options: ToolDefinerOptions<TContext>): ToolDefiner<TContext>
}

class ToolContractDefinition implements ToolContractDefinitionApi {
  public createDefiner<TContext>(options: ToolDefinerOptions<TContext>): ToolDefiner<TContext> {
    return <TInput extends Record<string, unknown>>(
      input: Omit<DefineToolRuntimeSpecInput<TInput, TContext, unknown, ToolPermission>, 'category'> & {
        name: string
        category?: ToolCategoryId
        inputReuse?: boolean
      }
    ): ToolContractRuntimeSpec<TInput, TContext, unknown, ToolPermission> => {
      const { inputReuse, category, ...spec } = input
      const resolvedCategory = category ?? options.categoryOf?.(input.name)
      if (!resolvedCategory)
        throw new AppError('INVARIANT', `工具 ${input.name} 没有类别：定义时给 category，或者给 createDefiner 一张按工具名查类别的表。`)
      const defined = defineToolRuntimeSpec<TInput, TContext, unknown, ToolPermission>({
        ...spec,
        category: resolvedCategory,
        inputContractVersion: input.inputContractVersion ?? options.contractVersion,
      })
      const wrapped = Boolean(inputReuse) && Boolean(options.inputReuse)
      if (!wrapped && !options.wrapExecute) return defined
      const execute: ToolContractExecute<TInput, TContext, unknown> = options.wrapExecute
        ? (options.wrapExecute(defined) as ToolContractExecute<TInput, TContext, unknown>)
        : defined.execute
      return Object.freeze({
        ...defined,
        schema: wrapped ? (options.inputReuse!(defined.schema) as typeof defined.schema) : defined.schema,
        execute,
      })
    }
  }
}

/** 整个进程只有一份的工具定义入口。 */
export const toolContracts: ToolContractDefinitionApi = new ToolContractDefinition()
