import { isArray, isEmpty, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { CompletionValidationInput } from '../types/completion-validation.js'

import { CompletionValidationLimits } from './tuning.js'

/** 接收门只允许固定的需求、证据与源码字段；命令、环境和宿主路径由宿主决定。 */
export function completionValidationInput(value: unknown): CompletionValidationInput {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !['requirementIds', 'artifacts', 'code'].includes(key)) ||
    !isArray(value.requirementIds) ||
    isEmpty(value.requirementIds) ||
    value.requirementIds.length > CompletionValidationLimits.artifacts ||
    !value.requirementIds.every((id) => isString(id) && id.length > 0 && id.length <= 256) ||
    new Set(value.requirementIds).size !== value.requirementIds.length ||
    !isArray(value.artifacts) ||
    isEmpty(value.artifacts) ||
    value.artifacts.length > CompletionValidationLimits.artifacts ||
    !isString(value.code) ||
    !value.code.trim() ||
    Buffer.byteLength(value.code) > CompletionValidationLimits.codeBytes
  )
    throw new AppError('PROTOCOL', '验证需要 1..16 个需求、1..16 个产物和不超过 32768 字节的代码')
  const artifacts = value.artifacts.map((artifact) => {
    if (
      !isPlainObject(artifact) ||
      Object.keys(artifact).some((key) => !['identity', 'sha256'].includes(key)) ||
      !isString(artifact.identity) ||
      !artifact.identity.startsWith('file:') ||
      artifact.identity.length > 1024 ||
      !isString(artifact.sha256) ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
      throw new AppError('PROTOCOL', '验证产物必须来自当前文件目录并携带完整 SHA256')
    return { identity: artifact.identity, sha256: artifact.sha256 }
  })
  if (new Set(artifacts.map((artifact) => artifact.identity)).size !== artifacts.length)
    throw new AppError('PROTOCOL', '验证产物身份不能重复')
  return { requirementIds: value.requirementIds as string[], artifacts, code: value.code }
}
