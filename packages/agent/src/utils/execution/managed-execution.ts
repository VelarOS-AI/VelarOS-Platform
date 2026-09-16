import { isBlank, isString } from '@velaros-ai/core'

export function resolveAbortReason(reason: unknown): string {
  if (isString(reason) && !isBlank(reason)) return reason
  if (reason instanceof Error && !isBlank(reason.message)) return reason.message
  return '运行被终止'
}
