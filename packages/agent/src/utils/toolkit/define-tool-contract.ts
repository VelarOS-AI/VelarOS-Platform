import { isBoolean, isObject, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  DefaultToolContractExampleRegistry,
  renderToolExampleInputs,
  serializeToolExampleInput,
  type ToolContractExampleRegistry,
} from '../../impl/tools/ToolContractExampleRegistry'
import type { DefineToolContractInput, DefineToolRuntimeSpecInput, ToolContractDescriptionSpec, ToolContractRuntimeSpec, ToolContractSpec, ToolContractSurface, ToolReadOnlyClassification } from '../../types/toolkit.js'

import { assertCanonicalToolId } from './identity'
import {
  assertToolDescriptionWithinBudget,
  assertToolDescriptionWithinLimit,
  renderUsageSkillNote,
  structureToolDescriptionForModel,
} from './tool-description'

/** 行为 effect 是只读真值；缺席时才采用显式声明，旧工具最后回退 role。 */
function resolveToolReadOnly(tool: ToolReadOnlyClassification): boolean {
  const effectKind = tool.capabilities?.effectKind
  if (effectKind) return effectKind === 'read'
  if (isBoolean(tool.readOnly)) return tool.readOnly
  return tool.role === 'inspect'
}

/**
 * 在工具注册期校验契约里写的示例入参：每条示例先按**模型实际会发的那份 JSON**序列化再解析回来
 * （这样 Date、undefined 之类只在内存里成立的值会现原形），再交给工具自己的 schema `safeParse`。
 * 有一条不过就抛 `VALIDATION` AppError，message 里带工具名、原示例和逐条 `路径: 原因`
 * （根级路径记作 `<root>`）。示例是直接给模型抄的范本，坏示例必须在装配时炸，不能等模型照着抄才发现。
 */
function validateToolContractExamples(
  toolName: string,
  schema: {
    safeParse(
      input: unknown
    ):
      | { success: true }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
  },
  examples: ReadonlyArray<Record<string, unknown>>
): void {
  for (const example of examples) {
    // 校验模型将发送的形状，避免 Date、undefined 等内存值在序列化后变成不合法示例。
    const parsed = schema.safeParse(JSON.parse(serializeToolExampleInput(example)))
    if (parsed.success) {
      continue
    }

    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join('.') || '<root>'
        return `${path}: ${issue.message}`
      })
      .join('; ')

    throw new AppError(
      'VALIDATION',
      `工具契约 ${toolName} 的示例不满足自己的 schema：${JSON.stringify(example)}（${issues}）。示例是按模型实际发送的形状校验的，请改示例或改 schema，让两者对上。`
    )
  }
}

/**
 * 从契约输入里摘出描述规格。
 *
 * `DefineTool*Input` 与 surface 输入都 `extends ToolContractDescriptionSpec`，八个字段同名同义；
 * 逐字段抄三遍会在新增描述字段时静默漏掉某一处，故收成单一摘取点。
 */
function pickToolDescriptionSpec(input: ToolContractDescriptionSpec): ToolContractDescriptionSpec {
  return {
    role: input.role,
    summary: input.summary,
    suitable: input.suitable,
    forbidden: input.forbidden,
    protocol: input.protocol,
    usage: input.usage,
    examples: input.examples,
    notes: input.notes,
    usageSkillId: input.usageSkillId,
    descriptionBudgetWaiver: input.descriptionBudgetWaiver,
  }
}

/**
 * companion skill 指路行进 `注意` 分节的末尾，而不是另起一段。
 *
 * 结构化描述的语法只认七个固定分节（`isStructuredToolDescription`），新起一段会直接判非结构化、
 * 被注册期断言拦下；追加成 `注意` 的最后一条既是「描述末尾一行」，又不动语法。
 */
function withUsageSkillNote(
  notes: ToolContractDescriptionSpec['notes'],
  usageSkillId: LooseOptional<string>
): ToolContractDescriptionSpec['notes'] {
  if (!isPresent(usageSkillId)) return notes
  return [...(notes ?? []), renderUsageSkillNote(usageSkillId)] as ToolContractDescriptionSpec['notes']
}

/**
 * 把描述规格编译成模型最终看到的那段工具描述，并**登记示例**（`examples.set(name, …)`，
 * 供 tool_map / schema 自恢复等处回查）。companion skill 指路会追加进「注意」分节末尾，
 * 而不是另起一段（另起会被判非结构化）。
 * 这是全部工具（含各 surface）描述的唯一构造点，所以两道长度闸门只能在这里拦：
 * `assertToolDescriptionWithinLimit` 是硬上限，`assertToolDescriptionWithinBudget` 是预算闸、
 * 可由契约的 `descriptionBudgetWaiver` 豁免。描述从不压缩，写下来那一刻不拦就永远拦不住。
 */
function buildToolContractDescription(
  name: string,
  categoryId: DefineToolContractInput['category'],
  spec: ToolContractDescriptionSpec,
  examples: ToolContractExampleRegistry = DefaultToolContractExampleRegistry
): string {
  examples.set(name, spec.examples ?? [])
  const description = structureToolDescriptionForModel({
    categoryId,
    description: spec.summary,
    suitable: spec.suitable,
    forbidden: spec.forbidden,
    protocol: spec.protocol,
    usage: spec.usage,
    examples: spec.examples ? renderToolExampleInputs(spec.examples) : undefined,
    notes: withUsageSkillNote(spec.notes, spec.usageSkillId),
  })
  // 描述从不压缩，所以两道闸只能在写下来的那一刻拦；这里是全部工具（含 surface）描述的唯一构造点。
  assertToolDescriptionWithinLimit(name, description)
  assertToolDescriptionWithinBudget(name, description, spec.descriptionBudgetWaiver)
  return description
}

/**
 * 声明一条工具**契约**（只有形状与描述，配 execute 但不含 runtime 独有字段如 outputInline）。
 * 装配时依次做三件会抛错的事：断言 name 是 canonical 工具 id、校验示例能过自己的 schema、
 * 编译描述并过长度/预算两道闸——任一不过就直接抛，坏工具进不了注册表。
 * 其余字段原样透传，只有 `permissions` 缺省会补成空数组。
 */
function defineToolContract<TInput extends Record<string, unknown>, TContext = unknown>(
  input: DefineToolContractInput<TInput, TContext>,
  examples: ToolContractExampleRegistry = DefaultToolContractExampleRegistry
): ToolContractSpec<TInput, TContext> {
  assertCanonicalToolId(input.name)
  const descriptionSpec = pickToolDescriptionSpec(input)
  validateToolContractExamples(input.name, input.schema, descriptionSpec.examples ?? [])
  return {
    name: input.name,
    category: input.category,
    role: input.role,
    descriptionSpec,
    description: buildToolContractDescription(
      input.name,
      input.category,
      descriptionSpec,
      examples
    ),
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

/**
 * 逐 surface 校验示例并把描述规格编译成模型面文案。
 *
 * 与主契约同一条流水线（校验示例 → 摘描述规格 → 生成描述），故不在此重写第二套规则；
 * surface 缺席时原样透传，让 `defineToolRuntimeSpec` 的 `surfaces` 保持「未声明」而非空对象。
 */
function buildToolRuntimeSurfaces<TInput extends Record<string, unknown>, TContext>(
  input: Pick<DefineToolRuntimeSpecInput<TInput, TContext>, 'name' | 'category' | 'surfaces'>,
  examples: ToolContractExampleRegistry
): Record<string, ToolContractSurface<any, TInput, TContext> | undefined> | undefined {
  if (!isPresent(input.surfaces)) return undefined

  return Object.fromEntries(
    Object.entries(input.surfaces).map(([profile, surface]) => {
      if (!isPresent(surface)) return [profile, surface]

      const surfaceName = `${input.name}.${profile}`
      validateToolContractExamples(surfaceName, surface.schema, surface.examples ?? [])
      return [
        profile,
        {
          description: buildToolContractDescription(
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

/**
 * 声明一条工具的**运行期规格**——`defineToolContract` 那套校验（canonical id、示例过 schema、
 * 描述两道闸）全都照做，另外多两件事：逐 surface 编译各自的描述与示例（surface 未声明时保持 undefined
 * 而不是空对象），以及由 `resolveToolReadOnly` 定出 `readOnly`——以 `capabilities.effectKind === 'read'`
 * 为准，没声明 effectKind 才看显式 `readOnly`，再没有就按 `role === 'inspect'` 兜底。
 * 内置工具都经由 `defineVelaTool` 走到这里。
 */
function defineToolRuntimeSpec<
  TInput extends Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
  TPermission extends string = string,
>(
  input: DefineToolRuntimeSpecInput<TInput, TContext, TResult, TPermission>,
  examples: ToolContractExampleRegistry = DefaultToolContractExampleRegistry
): ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission> {
  assertCanonicalToolId(input.name)
  const descriptionSpec = pickToolDescriptionSpec(input)
  validateToolContractExamples(input.name, input.schema, descriptionSpec.examples ?? [])

  const surfaces = buildToolRuntimeSurfaces<TInput, TContext>(
    input,
    examples
  ) as ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission>['surfaces']

  return {
    name: input.name,
    category: input.category,
    role: input.role,
    summary: input.summary,
    readOnly: resolveToolReadOnly(input),
    description: buildToolContractDescription(
      input.name,
      input.category,
      descriptionSpec,
      examples
    ),
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

/**
 * 鸭子判定一个值是否是工具契约：同时具备 `name`、`category`、`role`、`description`、`schema`、
 * `execute` 六个键即为真。只看键在不在、不看值的类型，用于从混杂导出里筛出工具——
 * 真正的形状保证来自 `defineToolContract` 那条构造路径。
 */
function isToolContractSpec(
  value: unknown
): value is ToolContractSpec<Record<string, unknown>, unknown> {
  return (
    isObject(value) &&
    'name' in value &&
    'category' in value &&
    'role' in value &&
    'description' in value &&
    'schema' in value &&
    'execute' in value
  )
}

export {
  buildToolContractDescription,
  defineToolContract,
  defineToolRuntimeSpec,
  isToolContractSpec,
  resolveToolReadOnly,
}
