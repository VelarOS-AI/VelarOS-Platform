/** 挂进内核时的小判定：集合里的一项到底是不是能执行的工具规格。 */

import { isArray, isFunction, isPlainObject, isPresent } from '@velaros-ai/core'

import type { CallableToolSpec } from '../types/toolkit.js'

/** 判断集合里的一项是不是能执行的工具规格：有 execute、权限表和 schema。 */
export function isCallableToolSpec<TContext>(value: unknown): value is CallableToolSpec<TContext> {
  return isPlainObject(value) && isFunction(value.execute) && isArray(value.permissions) && isPresent(value.schema)
}
