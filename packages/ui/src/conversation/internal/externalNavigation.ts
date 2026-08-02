// 对话内打开外部链接的唯一出口。所有渲染器共用协议白名单，非法链接一律拒绝。
import { normalizeHtmlArtifactExternalUrl } from '@velaros-ai/html-artifacts/sandbox'

/**
 * 校验并打开外部链接。返回是否真的打开了（false = 被协议门拒绝或环境无 `window.open`）。
 */
export function openExternalUrl(value: unknown): boolean {
  const normalized = normalizeHtmlArtifactExternalUrl(value)
  if (!normalized) return false

  const opener = globalThis.window?.open
  if (!opener) return false

  opener.call(globalThis.window, normalized, '_blank', 'noopener,noreferrer')
  return true
}
