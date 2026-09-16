import { isArray, isNumber, isPlainObject,isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserPageInspection, BrowserRecipeSkeleton } from '../../types/browser'
import type { BrowserRecipeRunRecord } from '../../types/recipes.js'

/** 解析并校验 recipe skeleton JSON。 */
export function parseRecipeSkeleton(path: string, content: string): BrowserRecipeSkeleton {
  const parsed = parseJsonArtifact(path, content, ' recipe skeleton')

  const record = isPlainObject(parsed) ? (parsed) : null
  // 最小结构校验：version=1 且包含 suggestedSteps。
  if (!record || record.version !== 1 || !isArray(record.suggestedSteps)) {
    throw new AppError('VALIDATION', `无效的 recipe skeleton：${path}`)
  }

  return parsed as BrowserRecipeSkeleton
}

/** 解析并校验 page snapshot JSON。 */
export function parseBrowserPageSnapshot(path: string, content: string): BrowserPageInspection {
  const parsed = parseJsonArtifact(path, content, '页面快照')

  const record = isPlainObject(parsed) ? (parsed) : null
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

  const record = isPlainObject(parsed) ? (parsed) : null
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

/** 把产物文件的内容解析成 JSON；坏了就带上路径明确报错。 */
function parseJsonArtifact(path: string, content: string, label: string): unknown {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new AppError('VALIDATION', `无法解析${label}：${path}`, error)
  }
}
export type { BrowserRecipeRunRecord } from '../../types/recipes.js'
