import type { ContentBlock, ToolCallBlock as ToolCallBlockType } from '#contracts'
import { isFalse, isRecord } from '#internal/runtime'
import { readStringScalar } from '#internal/unknownJsonRecord'

/**
 * 浏览器截图存在性谓词（AssistantMessageBubble 用它决定是否挂载 `browserScreenshotGroup` slot）。
 *
 * 与宿主 `BrowserScreenshotGroup.readBrowserScreenshot` 的可见性判定逐字节镜像（自动截图跳过未变更、
 * 手动 `browser_capture_screenshot` 保留、`ok !== false` 且有 `path`），只判存在不建对象——slot 挂载门
 * 是纯谓词，完整截图对象仍在宿主 slot 实现内构建。
 */
function artifactHasVisibleScreenshot(artifact: unknown, skipUnchanged: boolean): boolean {
  if (!isRecord(artifact)) return false
  if (isFalse(artifact.ok)) return false

  const diff = isRecord(artifact.diff) ? artifact.diff : null
  if (skipUnchanged && (isFalse(diff?.changed) || readStringScalar(diff?.reason) === 'unchanged'))
    return false

  return !!readStringScalar(artifact.path)
}

function blockHasVisibleBrowserScreenshot(block: ToolCallBlockType): boolean {
  if (!isRecord(block.result)) return false

  if (isRecord(block.result.automaticScreenshot))
    return artifactHasVisibleScreenshot(block.result.automaticScreenshot, true)

  if (block.toolName !== 'browser_capture_screenshot') return false

  return artifactHasVisibleScreenshot(block.result, false)
}

export function hasVisibleBrowserScreenshots(blocks: ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    if (blockHasVisibleBrowserScreenshot(block)) return true
  }

  return false
}
