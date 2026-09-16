/**
 * 定义一条工具时的两件杂活：校验契约里写的示例、从契约输入里摘出描述规格。
 * 都不认识示例登记表与说明渲染器，要用就由调用方把函数传进来。
 */

import { isBoolean } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ToolContractDescriptionSpec, ToolReadOnlyClassification } from '../types/tool-contract.js'

/** 行为 effect 是只读真值；缺席时才采用显式声明，旧工具最后回退 role。 */
export function resolveToolReadOnly(tool: ToolReadOnlyClassification): boolean {
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
 * 序列化交给调用方传进来的 `serialize`，本文件不认识示例登记表。
 */
export function validateToolContractExamples(
  toolName: string,
  schema: {
    safeParse(
      input: unknown
    ):
      | { success: true }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
  },
  examples: ReadonlyArray<Record<string, unknown>>,
  serialize: (value: unknown) => string
): void {
  for (const example of examples) {
    // 校验模型将发送的形状，避免 Date、undefined 等内存值在序列化后变成不合法示例。
    const parsed = schema.safeParse(JSON.parse(serialize(example)))
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
export function pickToolDescriptionSpec(input: ToolContractDescriptionSpec): ToolContractDescriptionSpec {
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
