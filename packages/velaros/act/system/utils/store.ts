import { isString } from '@velaros-ai/core'

import type { StoreGrant } from '../types/store.js'
/** 标记共享空间授权拒绝，明确尚未产生效果。 */
export function storeDenied(message: string): Error {
  return Object.assign(new Error(message), { code: 'STORE_DENIED', effect: 'none' })
}

/** 校验对象键位于当前授权的字面前缀内。 */
export function assertStoreKey(access: StoreGrant, key: string, write: boolean): void {
  if (
    !isString(key) ||
    !(write ? access.write : access.read).some((prefix) => key.startsWith(prefix))
  )
    throw storeDenied('对象不在当前授权范围内')
}
