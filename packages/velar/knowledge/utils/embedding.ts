/** 嵌入链路的公共判定：错误文字归一化、故障去重键，以及向量数组的校验与包装。 */

import { isArray, isFiniteNumber, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { EmbeddingApiItem } from '../types/host.js'

import { KnowledgeTuning } from './tuning.js'

/** 把任意抛出来的东西读成一句错误文字。 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isString(error)) return error
  if (error && isObject(error)) {
    const message = (error as { message?: unknown }).message
    return isString(message) ? message : String(message)
  }
  return String(error)
}

/** 算出一次向量故障的去重键：同一类鉴权失败归一条，其余按错误文字前缀分组。 */
export function normalizeVectorFailureKey(scope: string, message: string): string {
  if (/invalid_issuer|valid issuer|401 Unauthorized/i.test(message)) return `${scope}:embedding-auth-invalid-issuer`

  if (/authorization|api[_ -]?key|401/i.test(message)) return `${scope}:embedding-auth`

  return `${scope}:${message.slice(0, KnowledgeTuning.vectorFailure.messageKeyChars)}`
}

/** 确保向量是有限数字数组，避免 NaN/Infinity 写进 LanceDB。 */
export function isFiniteNumberArray(value: unknown): value is number[] {
  return isArray(value) && value.every((item) => isFiniteNumber(item))
}

/** 校验单个向量并包装成统一结构，格式不对就报网络错误。 */
export function normalizeEmbeddingVector(embedding: unknown): EmbeddingApiItem {
  if (!isFiniteNumberArray(embedding)) {
    throw new AppError('NETWORK', 'Embedding 向量格式不正确')
  }

  return { embedding }
}
