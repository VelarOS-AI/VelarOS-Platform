import type { BrowserPageInspection, BrowserRecipeSkeleton } from '@velaros-ai/browser-core'
import { isArray, isNumber, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserRecipeRunStepResult } from './RecipePlan'

/** 持久化到 runs/ 的 recipe 执行记录结构。 */
interface BrowserRecipeRunRecord {
  /** 原始 recipe artifact 路径。 */
  recipePath: string
  /** recipe 创建时的页面 URL。 */
  recipeUrl: string
  /** recipe 标题。 */
  recipeTitle: string
  /** 是否为 dryRun 预检。 */
  dryRun: boolean
  /** 执行开始时间戳。 */
  startedAt: number
  /** 执行结束时间戳。 */
  finishedAt: number
  /** recipe 中可执行步骤数量。 */
  executableStepCount: number
  /** 实际执行成功的步骤数量。 */
  executedStepCount: number
  /** 跳过/未命中/缺输入的步骤数量。 */
  skippedStepCount: number
  /** 必填输入名列表。 */
  requiredInputNames: string[]
  /** 可选输入名列表。 */
  optionalInputNames: string[]
  /** 调用方传入但 recipe 没用到的输入名。 */
  unusedInputNames: string[]
  /** 缺失输入详情。 */
  missingInputs: Array<{
    stepId: string
    name: string
    label: string
    type: string
    required: boolean
  }>
  /** 本次输入中实际引用的变量占位符名；旧 run record 可能没有。 */
  usedVariableNames?: string[]
  /** 调用方传入但未被输入占位符使用的变量名；旧 run record 可能没有。 */
  unusedVariableNames?: string[]
  /** dryRun 中发现、真实执行前会要求补齐的变量名；旧 run record 可能没有。 */
  missingVariableNames?: string[]
  /** 每一步预览或执行结果。 */
  stepResults: BrowserRecipeRunStepResult[]
}

/** 解析并校验 recipe skeleton JSON。 */
export function parseRecipeSkeleton(path: string, content: string): BrowserRecipeSkeleton {
  const parsed = parseJsonArtifact(path, content, ' recipe skeleton')

  const record = isObject(parsed) ? (parsed as Record<string, unknown>) : null
  // 最小结构校验：version=1 且包含 suggestedSteps。
  if (!record || record.version !== 1 || !isArray(record.suggestedSteps)) {
    throw new AppError('VALIDATION', `无效的 recipe skeleton：${path}`)
  }

  return parsed as BrowserRecipeSkeleton
}

/** 解析并校验 page snapshot JSON。 */
export function parseBrowserPageSnapshot(path: string, content: string): BrowserPageInspection {
  const parsed = parseJsonArtifact(path, content, '页面快照')

  const record = isObject(parsed) ? (parsed as Record<string, unknown>) : null
  // 快照必须包含 inspectPage 产出的核心字段。
  if (
    !record ||
    !isString(record.url) ||
    !isString(record.title) ||
    !isArray(record.headings) ||
    !isArray(record.links) ||
    !isArray(record.actions) ||
    !isArray(record.formFields) ||
    !isNumber(record.capturedAt)
  ) {
    throw new AppError('VALIDATION', `无效的页面快照：${path}`)
  }

  return parsed as BrowserPageInspection
}

/** 解析并校验 recipe run record JSON。 */
export function parseBrowserRecipeRunRecord(path: string, content: string): BrowserRecipeRunRecord {
  const parsed = parseJsonArtifact(path, content, '运行记录')

  const record = isObject(parsed) ? (parsed as Record<string, unknown>) : null
  // run record 只做必要字段校验，兼容未来追加字段。
  if (
    !record ||
    !isString(record.recipePath) ||
    !isString(record.recipeUrl) ||
    !isString(record.recipeTitle) ||
    !isNumber(record.startedAt) ||
    !isNumber(record.finishedAt) ||
    !isArray(record.stepResults)
  ) {
    throw new AppError('VALIDATION', `无效的运行记录：${path}`)
  }

  return parsed as BrowserRecipeRunRecord
}

function parseJsonArtifact(path: string, content: string, label: string): unknown {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new AppError('VALIDATION', `无法解析${label}：${path}`, error)
  }
}

export type { BrowserRecipeRunRecord }
