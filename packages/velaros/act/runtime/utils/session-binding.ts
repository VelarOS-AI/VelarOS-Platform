import { isArray, isNonBlankString, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModuleBinding } from '@velaros-ai/kernel'

import type { RuntimeSessionBinding } from '../contract/requires.js'
import type { SessionBindingDocument } from '../types/binding.js'

/** 用同一稳定编码固定身份、授权与真实模块，保留第一代持久格式。 */
export function sessionBindingBody(
  binding: RuntimeSessionBinding,
  modules: readonly ModuleBinding[]
): string {
  return JSON.stringify({
    version: 1,
    executionIdentity: binding.executionIdentity,
    authorizationScope: binding.authorizationScope,
    modules: modules
      .map(({ moduleId, instanceId, generation }) => ({ moduleId, instanceId, generation }))
      .sort(
        (one, two) =>
          one.moduleId.localeCompare(two.moduleId) || one.instanceId.localeCompare(two.instanceId)
      ),
  })
}

/** 控制读取核验既有绑定完整性，不能从损坏或未知格式猜测授权。 */
export function readSessionBinding(body: string): SessionBindingDocument {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (cause) {
    throw AppError.withFields('CONFLICT', '会话执行绑定损坏', { cause })
  }
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    Object.keys(value).length !== 4 ||
    !isNonBlankString(value.executionIdentity) ||
    !isNonBlankString(value.authorizationScope) ||
    !isArray(value.modules) ||
    value.modules.some(
      (module) =>
        !isPlainObject(module) ||
        Object.keys(module).length !== 3 ||
        !isNonBlankString(module.moduleId) ||
        !isNonBlankString(module.instanceId) ||
        typeof module.generation !== 'number' ||
        !Number.isSafeInteger(module.generation) ||
        module.generation < 1
    )
  )
    throw new AppError('CONFLICT', '会话执行绑定格式损坏')
  const document = value as unknown as SessionBindingDocument
  if (
    new Set(document.modules.map((module) => JSON.stringify([module.moduleId, module.instanceId])))
      .size !== document.modules.length ||
    sessionBindingBody(document, document.modules) !== body
  )
    throw new AppError('CONFLICT', '会话能力绑定重复或编码损坏')
  return document
}
