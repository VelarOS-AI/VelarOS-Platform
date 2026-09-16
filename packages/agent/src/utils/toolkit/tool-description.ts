/** 模型面工具说明的渲染、判定、解析、压缩与两道长度闸：实现在 `@velaros-ai/tool-contract`，这里按原名转发。 */

import { toolDescriptions } from '@velaros-ai/tool-contract'

import type { ToolCategoryId } from '../../types/agent.js'
import type {
  StructuredParameterDescriptionSpec,
  StructuredToolDescriptionParts,
  StructuredToolDescriptionSpec,
  ToolDescriptionBudgetWaiver,
  ToolDescriptionLike,
} from '../../types/toolkit.js'

/** 单个工具说明的开发期硬上限（字符）：保底闸，不是预算；撞线基本等于这个工具该拆。 */
const ToolDescriptionMaxChars: number = toolDescriptions.maxChars

/** 模型面工具说明的软预算（字符）：复杂用法属于技能文书，出路是拆 companion skill 或显式豁免。 */
const ToolDescriptionBudgetChars: number = toolDescriptions.budgetChars

/** 保底闸：单个工具描述超过 `ToolDescriptionMaxChars` 就抛 `VALIDATION`，这道闸不可豁免。 */
function assertToolDescriptionWithinLimit(name: string, description: string): void {
  toolDescriptions.assertWithinLimit(name, description)
}

/** 软预算闸：超过 `ToolDescriptionBudgetChars` 就抛 `VALIDATION`；带合法豁免时跳过长度判定。 */
function assertToolDescriptionWithinBudget(
  name: string,
  description: string,
  waiver?: ToolDescriptionBudgetWaiver
): void {
  toolDescriptions.assertWithinBudget(name, description, waiver)
}

/** 声明了 companion skill 时追加到描述末尾的指路行（`注意` 分节的最后一条）。 */
function renderUsageSkillNote(usageSkillId: string): string {
  return toolDescriptions.renderUsageSkillNote(usageSkillId)
}

/** 把结构化描述规格渲染成模型看到的那段文本：固定分节顺序，没给的分节整节不出现。 */
function renderToolDescription(spec: StructuredToolDescriptionSpec): string {
  return toolDescriptions.renderTool(spec)
}

/** 渲染**单个参数**的结构化描述，语法比工具描述窄：只有 `描述` → `取值` → `用法` → `注意` 四节。 */
function renderParameterDescription(spec: StructuredParameterDescriptionSpec): string {
  return toolDescriptions.renderParameter(spec)
}

/** 判定一段**工具**描述是否结构化：七节语法，其中 `适合` 必填。 */
function isStructuredToolDescription(description: string): boolean {
  return toolDescriptions.isToolDescription(description)
}

/** 判定一段**参数**描述是否结构化：四节语法，没有必填分节。 */
function isStructuredParameterDescription(description: string): boolean {
  return toolDescriptions.isParameterDescription(description)
}

/** 把一段已渲染的工具描述解析回七个分节；不是合法结构化描述就返回 null。 */
function parseStructuredToolDescription(
  description: string
): Nullable<StructuredToolDescriptionParts> {
  return toolDescriptions.parseTool(description)
}

/** 产出模型面的工具描述文本，幂等：已是合法结构化描述就 trim 后原样返回。 */
function structureToolDescriptionForModel(
  input: StructuredToolDescriptionSpec & { categoryId: ToolCategoryId }
): string {
  return toolDescriptions.forModel(input)
}

/** 工具描述 tier-1 精简版：`强制流程：` 完整保留，其余分节各留首条。 */
function compactStructuredToolDescription(description: string): string {
  return toolDescriptions.compactTool(description)
}

/** 整类工具描述的结构化断言：有一个不是完全结构化就抛 `VALIDATION`；只校验不改写。 */
function structureToolDescriptionsForCategory<
  TTool extends ToolDescriptionLike,
  TMap extends Record<string, TTool>,
>(tools: TMap, categoryId: ToolCategoryId): TMap {
  return toolDescriptions.forCategory(tools, categoryId)
}

export {
  assertToolDescriptionWithinBudget,
  assertToolDescriptionWithinLimit,
  compactStructuredToolDescription,
  isStructuredParameterDescription,
  isStructuredToolDescription,
  parseStructuredToolDescription,
  renderParameterDescription,
  renderToolDescription,
  renderUsageSkillNote,
  structureToolDescriptionForModel,
  structureToolDescriptionsForCategory,
  ToolDescriptionBudgetChars,
  ToolDescriptionMaxChars,
}
