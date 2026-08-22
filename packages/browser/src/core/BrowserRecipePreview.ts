import {
  isArray,
  isBoolean,
  isNumber,
  isObject,
  isString,
  Log,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  BrowserRecipeSkeleton,
  BrowserRecipeSkeletonPreview,
  BrowserRecipeSkeletonStepInput,
} from './types.js'

const log = Log.tag('RecipePreview')

/**
 * 标准化 recipe 路径。
 *
 * 只允许访问当前浏览器网站 workspace 的 recipes/ 目录下 JSON 文件，
 * 防止用户用 ../ 或绝对路径读取其他 artifact。
 */
function normalizeBrowserRecipePath(path: string): string {
  const normalizedPath = path
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/+$/u, '')
    .replace(/^\/+/u, '')
  const segments = normalizedPath.split('/').filter(Boolean)

  if (
    normalizedPath !== segments.join('/') ||
    segments.length < 2 ||
    segments[0] !== 'recipes' ||
    segments.some((segment) => segment === '.' || segment === '..') ||
    !normalizedPath.endsWith('.json')
  ) {
    throw new AppError(
      'VALIDATION',
      '只能预览当前网站工区 recipes/ 目录下的 JSON recipe。',
    )
  }

  return normalizedPath
}

/** 获取 URL origin。 */
function getBrowserUrlOrigin(url: string): Nullable<string> {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch (error) {
    log.debug('解析 recipe URL origin 失败，按未知来源处理', {
      url,
      error: String(error),
    })
    return null
  }
}

/** 确保 recipe 目标网站与当前浏览器网站同源。 */
function assertSameBrowserOrigin(recipeUrl: string, contextUrl: string): void {
  const recipeOrigin = getBrowserUrlOrigin(recipeUrl)
  const contextOrigin = getBrowserUrlOrigin(contextUrl)

  if (recipeOrigin && contextOrigin && recipeOrigin !== contextOrigin) {
    throw new AppError(
      'PERMISSION',
      'recipe 不属于当前网站，不能在当前网站工区预览或运行。',
    )
  }
}

/** 从 recipe skeleton 中解析用户输入定义，格式不完整的 input 会被忽略。 */
function parseRecipeInputs(value: any): BrowserRecipeSkeletonStepInput[] {
  if (!isArray(value)) return []

  return value
    .map((input): Nullable<BrowserRecipeSkeletonStepInput> => {
      if (!input || !isObject(input)) return null

      const record = input as Partial<BrowserRecipeSkeletonStepInput>
      if (
        !isString(record.name) ||
        !isString(record.label) ||
        !isString(record.type) ||
        !isBoolean(record.required)
      )
        return null

      return {
        name: record.name,
        label: record.label,
        type: record.type,
        required: record.required,
      }
    })
    .filter((input): input is BrowserRecipeSkeletonStepInput => !!input)
}

/** 解析 recipe skeleton JSON，并生成 UI 预览需要的摘要结构。 */
function buildRecipeSkeletonPreview(
  path: string,
  content: string,
): BrowserRecipeSkeletonPreview {
  const parsed = JSON.parse(content) as Partial<BrowserRecipeSkeleton>
  if (
    parsed.version !== 1 ||
    !isString(parsed.url) ||
    !isString(parsed.title) ||
    !isString(parsed.summary)
  ) {
    throw new AppError('VALIDATION', 'recipe skeleton 格式无效。')
  }

  const inputs = parseRecipeInputs(parsed.inputs)
  const requiredInputNames = inputs
    .filter((input) => input.required)
    .map((input) => input.name)
  const optionalInputNames = inputs
    .filter((input) => !input.required)
    .map((input) => input.name)

  return {
    path,
    url: parsed.url,
    title: parsed.title,
    summary: parsed.summary,
    inputs,
    stepCount: isArray(parsed.suggestedSteps)
      ? parsed.suggestedSteps.length
      : 0,
    requiredInputNames,
    optionalInputNames,
    generatedAt: isNumber(parsed.generatedAt) ? parsed.generatedAt : 0,
  }
}

export {
  assertSameBrowserOrigin,
  buildRecipeSkeletonPreview,
  normalizeBrowserRecipePath,
}
