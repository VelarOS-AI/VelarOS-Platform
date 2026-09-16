/**
 * 定义一条工具：断言 canonical id、校验示例、编译模型面说明并过两道长度闸，逐 surface 同样走一遍。
 * 接口 `ToolContractDefinitionApi` 在本文件的类上方；整个进程一份 `toolContracts`。
 * 文件末尾的 `createToolDefiner` 是各空间的那一行：把类别、契约版本与入参复用信封一次填好。
 */

import { isObject, isPresent } from '@velaros-ai/core'

import type {
  ToolContractDescriptionSpec,
  ToolPermission,
  ToolReadOnlyClassification,
} from '../types/tool-contract.js'
import type {
  DefineToolContractInput,
  DefineToolRuntimeSpecInput,
  ToolContractExecute,
  ToolContractRuntimeSpec,
  ToolContractSpec,
  ToolContractSurface,
  ToolDefiner,
  ToolDefinerOptions,
} from '../types/toolkit.js'
import { pickToolDescriptionSpec, resolveToolReadOnly, validateToolContractExamples } from '../utils/definition.js'

import { toolDescriptions } from './ToolDescriptions.js'
import type { ToolExampleRegistryApi } from './ToolExampleRegistry.js'
import { renderToolExampleInputs, serializeToolExampleInput, toolExamples } from './ToolExampleRegistry.js'
import { toolIdentity } from './ToolIdentity.js'

/**
 * 工具定义的唯一入口，实例是 `toolContracts`。
 *
 * 装配时依次做会抛错的三件事：断言 name 是 canonical 工具 id、校验示例能过工具自己的 schema、
 * 编译说明并过硬上限与软预算两道闸——任一不过就直接抛，坏工具进不了注册表。
 * 说明只在这里被写下来，所以两道闸也只能在这里拦：模型面说明从不压缩，写下来那一刻不拦就永远拦不住。
 */
export interface ToolContractDefinitionApi {
  /**
   * 声明一条工具**契约**（只有形状与说明，配 execute 但不含运行期独有字段）。
   * 其余字段原样透传，只有 `permissions` 缺省会补成空数组。
   */
  define<TInput extends Record<string, unknown>, TContext = unknown>(
    input: DefineToolContractInput<TInput, TContext>,
    examples?: ToolExampleRegistryApi
  ): ToolContractSpec<TInput, TContext>
  /**
   * 声明一条工具的**运行期规格**：`define` 那套校验全都照做，另外逐 surface 编译各自的说明与示例
   * （surface 未声明时保持 undefined 而不是空对象），并定出 `readOnly`。
   */
  defineRuntime<
    TInput extends Record<string, unknown>,
    TContext = unknown,
    TResult = unknown,
    TPermission extends string = string,
  >(
    input: DefineToolRuntimeSpecInput<TInput, TContext, TResult, TPermission>,
    examples?: ToolExampleRegistryApi
  ): ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission>
  /**
   * 把描述规格编译成模型最终看到的那段说明，并**登记示例**供工具发现与 schema 自恢复回查。
   * companion skill 指路会追加进「注意」分节末尾，而不是另起一段（另起会被判非结构化）。
   */
  describe(
    name: string,
    categoryId: DefineToolContractInput['category'],
    spec: ToolContractDescriptionSpec,
    examples?: ToolExampleRegistryApi
  ): string
  /**
   * 鸭子判定一个值是否是工具契约：同时具备 `name`、`category`、`role`、`description`、`schema`、
   * `execute` 六个键即为真。只看键在不在、不看值的类型，用于从混杂导出里筛出工具。
   */
  isContract(value: unknown): value is ToolContractSpec<Record<string, unknown>, unknown>
  /** 行为 effect 是只读真值；缺席时才采用显式声明，旧工具最后回退 role。 */
  isReadOnly(tool: ToolReadOnlyClassification): boolean
  /**
   * 造一个「定义本空间工具」的函数：类别按名查表或固定填上，契约版本与入参复用信封一次配好，
   * 各空间只保留一行 `const defineXTool = toolContracts.createDefiner(…)`，不再各写一份同构的壳子。
   * 只在真的改了 schema 或 execute 时才返回新对象（并冻结），否则原样交出定义结果。
   */
  createDefiner<TContext>(options: ToolDefinerOptions<TContext>): ToolDefiner<TContext>
}

class ToolContractDefinition implements ToolContractDefinitionApi {
  /** 鸭子判定一条工具契约要同时具备的六个键。 */
  private static readonly ContractKeys = ['name', 'category', 'role', 'description', 'schema', 'execute']

  public define<TInput extends Record<string, unknown>, TContext = unknown>(
    input: DefineToolContractInput<TInput, TContext>,
    examples: ToolExampleRegistryApi = toolExamples
  ): ToolContractSpec<TInput, TContext> {
    toolIdentity.assertCanonical(input.name)
    const descriptionSpec = pickToolDescriptionSpec(input)
    validateToolContractExamples(input.name, input.schema, descriptionSpec.examples ?? [], serializeToolExampleInput)
    return {
      name: input.name,
      category: input.category,
      role: input.role,
      descriptionSpec,
      description: this.describe(input.name, input.category, descriptionSpec, examples),
      usageSkillId: input.usageSkillId,
      examples: input.examples,
      schema: input.schema,
      inputContractVersion: input.inputContractVersion,
      inputReuseSourceTools: input.inputReuseSourceTools,
      migrateReusedInput: input.migrateReusedInput,
      executeSchema: input.executeSchema,
      surfaces: input.surfaces,
      permissions: input.permissions ?? [],
      capabilities: input.capabilities,
      requiredModelInputModalities: input.requiredModelInputModalities,
      exposure: input.exposure,
      hideWhenUnavailable: input.hideWhenUnavailable,
      isAvailable: input.isAvailable,
      unavailableReason: input.unavailableReason,
      isConcurrencySafe: input.isConcurrencySafe,
      execute: input.execute,
    }
  }

  public defineRuntime<
    TInput extends Record<string, unknown>,
    TContext = unknown,
    TResult = unknown,
    TPermission extends string = string,
  >(
    input: DefineToolRuntimeSpecInput<TInput, TContext, TResult, TPermission>,
    examples: ToolExampleRegistryApi = toolExamples
  ): ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission> {
    toolIdentity.assertCanonical(input.name)
    const descriptionSpec = pickToolDescriptionSpec(input)
    validateToolContractExamples(input.name, input.schema, descriptionSpec.examples ?? [], serializeToolExampleInput)

    const surfaces = this.buildSurfaces<TInput, TContext>(
      input,
      examples
    ) as ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission>['surfaces']

    return {
      name: input.name,
      category: input.category,
      role: input.role,
      summary: input.summary,
      readOnly: this.isReadOnly(input),
      description: this.describe(input.name, input.category, descriptionSpec, examples),
      usageSkillId: input.usageSkillId,
      schema: input.schema,
      inputContractVersion: input.inputContractVersion,
      inputReuseSourceTools: input.inputReuseSourceTools,
      migrateReusedInput: input.migrateReusedInput,
      surfaces,
      permissions: input.permissions,
      capabilities: input.capabilities,
      requiredModelInputModalities: input.requiredModelInputModalities,
      exposure: input.exposure,
      outputInline: input.outputInline,
      hideWhenUnavailable: input.hideWhenUnavailable,
      isAvailable: input.isAvailable,
      unavailableReason: input.unavailableReason,
      isConcurrencySafe: input.isConcurrencySafe,
      execute: input.execute,
    }
  }

  public describe(
    name: string,
    categoryId: DefineToolContractInput['category'],
    spec: ToolContractDescriptionSpec,
    examples: ToolExampleRegistryApi = toolExamples
  ): string {
    examples.set(name, spec.examples ?? [])
    // companion skill 指路进「注意」分节末尾：另起一段会被判非结构化，注册期断言当场拦下。
    const notes = isPresent(spec.usageSkillId)
      ? ([
        ...(spec.notes ?? []),
        toolDescriptions.renderUsageSkillNote(spec.usageSkillId),
      ] as ToolContractDescriptionSpec['notes'])
      : spec.notes
    const description = toolDescriptions.forModel({
      categoryId,
      description: spec.summary,
      suitable: spec.suitable,
      forbidden: spec.forbidden,
      protocol: spec.protocol,
      usage: spec.usage,
      examples: spec.examples ? renderToolExampleInputs(spec.examples) : undefined,
      notes,
    })
    // 描述从不压缩，所以两道闸只能在写下来的那一刻拦；这里是全部工具（含 surface）描述的唯一构造点。
    toolDescriptions.assertWithinLimit(name, description)
    toolDescriptions.assertWithinBudget(name, description, spec.descriptionBudgetWaiver)
    return description
  }

  public isContract(value: unknown): value is ToolContractSpec<Record<string, unknown>, unknown> {
    return isObject(value) && ToolContractDefinition.ContractKeys.every((key) => key in value)
  }

  public isReadOnly(tool: ToolReadOnlyClassification): boolean {
    return resolveToolReadOnly(tool)
  }

  public createDefiner<TContext>(options: ToolDefinerOptions<TContext>): ToolDefiner<TContext> {
    return <TInput extends Record<string, unknown>>(
      input: Omit<DefineToolRuntimeSpecInput<TInput, TContext, unknown, ToolPermission>, 'category'> & {
        name: string
        category?: DefineToolContractInput['category']
        inputReuse?: boolean
      }
    ): ToolContractRuntimeSpec<TInput, TContext, unknown, ToolPermission> => {
      const { inputReuse, category, ...spec } = input
      const defined = this.defineRuntime<TInput, TContext, unknown, ToolPermission>({
        ...spec,
        category: category ?? options.categoryOf(input.name),
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

  /**
   * 逐 surface 校验示例并把描述规格编译成模型面文案。
   *
   * 与主契约同一条流水线（校验示例 → 摘描述规格 → 生成描述），故不在此重写第二套规则；
   * surface 缺席时原样透传，让运行期规格的 `surfaces` 保持「未声明」而非空对象。
   */
  private buildSurfaces<TInput extends Record<string, unknown>, TContext>(
    input: Pick<DefineToolRuntimeSpecInput<TInput, TContext>, 'name' | 'category' | 'surfaces'>,
    examples: ToolExampleRegistryApi
  ): Record<string, ToolContractSurface<any, TInput, TContext> | undefined> | undefined {
    if (!isPresent(input.surfaces)) return undefined

    return Object.fromEntries(
      Object.entries(input.surfaces).map(([profile, surface]) => {
        if (!isPresent(surface)) return [profile, surface]

        const surfaceName = `${input.name}.${profile}`
        validateToolContractExamples(surfaceName, surface.schema, surface.examples ?? [], serializeToolExampleInput)
        return [
          profile,
          {
            description: this.describe(
              surfaceName,
              input.category,
              pickToolDescriptionSpec(surface),
              examples
            ),
            schema: surface.schema,
            normalize: surface.normalize,
          } satisfies ToolContractSurface<any, TInput, TContext>,
        ]
      })
    )
  }
}

/** 整个进程只有一份的工具定义入口。 */
export const toolContracts: ToolContractDefinitionApi = new ToolContractDefinition()
