/**
 * 定义一条工具的唯一流水线：断言 canonical id、按模型会发的 JSON 校验示例、编译模型面说明并过两道长度闸，
 * 逐 surface 同样走一遍，最后定出只读。说明只在这里被写下来，所以两道闸也只能在这里拦：
 * 模型面说明从不压缩，写下来那一刻不拦就永远拦不住。内置工具的 `defineVelaTool` 与对外的
 * `toolContracts.createDefiner` 都经这里定义工具。
 */

import { isBoolean, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  DefineToolRuntimeSpecInput,
  ToolContractDescriptionSpec,
  ToolContractRuntimeSpec,
  ToolContractSurface,
  ToolReadOnlyClassification,
} from '../../types/toolkit.js'
import { assertCanonicalToolId } from '../tools/tool-identity'

import { renderToolExampleInputs, serializeToolExampleInput } from './examples'
import {
  assertToolDescriptionWithinBudget,
  assertToolDescriptionWithinLimit,
  renderUsageSkillNote,
  structureToolDescriptionForModel,
} from './tool-description'

/** 行为 effect 是只读真值；缺席时才采用显式声明，旧工具最后回退 role。 */
export function resolveToolReadOnly(tool: ToolReadOnlyClassification): boolean {
  const effectKind = tool.capabilities?.effectKind
  if (effectKind) return effectKind === 'read'
  if (isBoolean(tool.readOnly)) return tool.readOnly
  return tool.role === 'inspect'
}

/**
 * 声明一条工具的**运行期规格**：断言 name 是 canonical 工具 id、校验示例能过工具自己的 schema、
 * 编译说明并过硬上限与软预算两道闸——任一不过就直接抛，坏工具进不了注册表；
 * 另外逐 surface 编译各自的说明与示例（surface 未声明时保持 undefined 而不是空对象），并定出 `readOnly`。
 */
export function defineToolRuntimeSpec<
  TInput extends Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
  TPermission extends string = string,
>(
  input: DefineToolRuntimeSpecInput<TInput, TContext, TResult, TPermission>
): ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission> {
  assertCanonicalToolId(input.name)
  const descriptionSpec = pickToolDescriptionSpec(input)
  validateToolContractExamples(input.name, input.schema, descriptionSpec.examples ?? [])

  const surfaces = buildToolRuntimeSurfaces<TInput, TContext>(
    input
  ) as ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission>['surfaces']

  return {
    name: input.name,
    category: input.category,
    role: input.role,
    summary: input.summary,
    readOnly: resolveToolReadOnly(input),
    description: buildToolContractDescription(input.name, descriptionSpec),
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
 * 把描述规格编译成模型最终看到的那段说明：示例渲染成「示例：」分节，companion skill 指路追加进「注意」分节末尾
 * （另起一段会被判非结构化），再过硬上限与软预算两道闸。这里是全部工具（含 surface）说明的唯一构造点。
 */
function buildToolContractDescription(name: string, spec: ToolContractDescriptionSpec): string {
  const notes = isPresent(spec.usageSkillId)
    ? ([
      ...(spec.notes ?? []),
      renderUsageSkillNote(spec.usageSkillId),
    ] as ToolContractDescriptionSpec['notes'])
    : spec.notes
  const description = structureToolDescriptionForModel({
    description: spec.summary,
    suitable: spec.suitable,
    forbidden: spec.forbidden,
    protocol: spec.protocol,
    usage: spec.usage,
    examples: spec.examples ? renderToolExampleInputs(spec.examples) : undefined,
    notes,
  })
  assertToolDescriptionWithinLimit(name, description)
  assertToolDescriptionWithinBudget(name, description, spec.descriptionBudgetWaiver)
  return description
}

/**
 * 逐 surface 校验示例并把描述规格编译成模型面文案。
 *
 * 与主契约同一条流水线（校验示例 → 摘描述规格 → 生成描述），故不在此重写第二套规则；
 * surface 缺席时原样透传，让运行期规格的 `surfaces` 保持「未声明」而非空对象。
 */
function buildToolRuntimeSurfaces<TInput extends Record<string, unknown>, TContext>(
  input: Pick<DefineToolRuntimeSpecInput<TInput, TContext>, 'name' | 'surfaces'>
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
          description: buildToolContractDescription(surfaceName, pickToolDescriptionSpec(surface)),
          schema: surface.schema,
          normalize: surface.normalize,
        } satisfies ToolContractSurface<any, TInput, TContext>,
      ]
    })
  )
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
 * `DefineToolRuntimeSpecInput` 与 surface 输入都 `extends ToolContractDescriptionSpec`，字段同名同义；
 * 逐字段抄两遍会在新增描述字段时静默漏掉某一处，故收成单一摘取点。
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
