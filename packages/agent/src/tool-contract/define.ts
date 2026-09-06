import { isBoolean, isObject, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  DefaultToolContractExampleRegistry,
  renderToolExampleInputs,
  type ToolContractExampleRegistry,
} from './examples'
import { assertCanonicalToolId } from './identity'
import {
  assertToolDescriptionWithinBudget,
  assertToolDescriptionWithinLimit,
  renderUsageSkillNote,
  structureToolDescriptionForModel,
} from './ToolDescription'
import type {
  DefineToolContractInput,
  DefineToolRuntimeSpecInput,
  ToolContractDescriptionSpec,
  ToolContractRuntimeSpec,
  ToolContractSpec,
  ToolContractSurface,
} from './types'

interface ToolReadOnlyClassification {
  readOnly?: boolean
  role?: string
  capabilities?: { effectKind?: string }
}

/** 行为 effect 是只读真值；缺席时才采用显式声明，旧工具最后回退 role。 */
function resolveToolReadOnly(tool: ToolReadOnlyClassification): boolean {
  const effectKind = tool.capabilities?.effectKind
  if (effectKind) return effectKind === 'read'
  if (isBoolean(tool.readOnly)) return tool.readOnly
  return tool.role === 'inspect'
}

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
    const parsed = schema.safeParse(example)
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
      `Tool contract ${toolName} example does not satisfy schema: ${JSON.stringify(example)} (${issues})`
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
  return [...notes, renderUsageSkillNote(usageSkillId)] as ToolContractDescriptionSpec['notes']
}

function buildToolContractDescription(
  name: string,
  categoryId: DefineToolContractInput['category'],
  spec: ToolContractDescriptionSpec,
  examples: ToolContractExampleRegistry = DefaultToolContractExampleRegistry
): string {
  examples.set(name, spec.examples)
  const description = structureToolDescriptionForModel({
    categoryId,
    description: spec.summary,
    suitable: spec.suitable,
    forbidden: spec.forbidden,
    protocol: spec.protocol,
    usage: spec.usage,
    examples: renderToolExampleInputs(spec.examples),
    notes: withUsageSkillNote(spec.notes, spec.usageSkillId),
  })
  // 描述从不压缩，所以两道闸只能在写下来的那一刻拦；这里是全部工具（含 surface）描述的唯一构造点。
  assertToolDescriptionWithinLimit(name, description)
  assertToolDescriptionWithinBudget(name, description, spec.descriptionBudgetWaiver)
  return description
}

function defineToolContract<TInput extends Record<string, unknown>, TContext = unknown>(
  input: DefineToolContractInput<TInput, TContext>,
  examples: ToolContractExampleRegistry = DefaultToolContractExampleRegistry
): ToolContractSpec<TInput, TContext> {
  assertCanonicalToolId(input.name)
  const descriptionSpec = pickToolDescriptionSpec(input)
  validateToolContractExamples(input.name, input.schema, descriptionSpec.examples)
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
function buildToolRuntimeSurfaces<
  TInput extends Record<string, unknown>,
  TContext,
>(
  input: Pick<DefineToolRuntimeSpecInput<TInput, TContext>, 'name' | 'category' | 'surfaces'>,
  examples: ToolContractExampleRegistry
): Record<string, ToolContractSurface<any, TInput, TContext> | undefined> | undefined {
  if (!isPresent(input.surfaces)) return undefined

  return Object.fromEntries(
    Object.entries(input.surfaces).map(([profile, surface]) => {
      if (!isPresent(surface)) return [profile, surface]

      const surfaceName = `${input.name}.${profile}`
      validateToolContractExamples(surfaceName, surface.schema, surface.examples)
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
  validateToolContractExamples(input.name, input.schema, descriptionSpec.examples)

  const surfaces = buildToolRuntimeSurfaces<TInput, TContext>(input, examples) as
    ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission>['surfaces']

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
