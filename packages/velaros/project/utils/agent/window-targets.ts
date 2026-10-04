/** 连续窗口签发独立目标，不连续的窗口不能把中间没显示的源码授予编辑。 */
import { isEmpty, isUndefined } from '@velaros-ai/core'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type { ProjectWindow } from '../../types/files.js'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import { createProjectSourceCoordinates } from '../editing/source.js'

import { loadFileView } from './file-refs.js'
import { saveSelection } from './selection-refs.js'
import { finalizeFileWindows, toProjectWindows } from './source-window.js'

/** 展示正文一次，并绑定每个连续窗口；范围越出文件的空窗口维持只读。 */
export async function editableProjectWindows(
  ctx: ProjectOperationContext,
  windows: readonly ProjectSourceWindow[]
): Promise<ProjectWindow[]> {
  const result: ProjectWindow[] = []
  for (const window of await finalizeFileWindows(ctx, windows)) {
    const shaped = toProjectWindows(window)
    if (window.fileRef) {
      const view = await loadFileView(ctx, window.fileRef)
      const source = createProjectSourceCoordinates(view.content)
      for (const item of shaped) {
        const start = source.lines[item.startLine - 1]?.start
        const endLine = item.startLine + item.text.split('\n').length - 1
        const end = source.lines[endLine - 1]?.end
        if (isUndefined(start) || isUndefined(end) || isEmpty(window.lines)) continue
        const whole = start === 0 && end === view.content.length && item.startLine === 1
        item.target = saveSelection(
          ctx,
          window.fileRef,
          view,
          start,
          end,
          whole ? 'file' : 'lines',
          undefined,
          source
        )
      }
    }
    result.push(...shaped)
  }
  return result
}
