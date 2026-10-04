/** 已确认的目标绑定到实际交付范围；模型提供的说明字段不参与定位。 */
import type { ProjectOperationContext } from '../../contract/requires.js'
import type { ProjectSourceCoordinates } from '../../types/editing.js'
import type { ProjectFileView } from '../../types/file-refs.js'
import type { ProjectSelection, ProjectSelectionRecord } from '../../types/selection.js'
import { assertVisibleSpan } from '../editing/selection-coverage.js'
import { createProjectSourceCoordinates, sourceLineAt } from '../editing/source.js'
import { ProjectError } from '../errors.js'

import { loadFileView, readReceipt, saveReceipt } from './file-refs.js'

/** 只取签发身份，路径、偏移、kind 等客户端说明字段不能改变绑定。 */
export function selectionRef(value: unknown): string {
  const ref =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'ref' in value
        ? value.ref
        : undefined
  if (typeof ref !== 'string' || !/^target:[a-f0-9]{8}$/.test(ref))
    throw new ProjectError(
      'INVALID_INPUT',
      'target 要 select/read 返回的对象或 target: 加 8 位引用。'
    )
  return ref
}

/** 在一个已有可见视图内绑定目标；新视图只覆盖这次返回的目标，不继承未展示的全文编辑范围。 */
export function saveSelection(
  ctx: ProjectOperationContext,
  fileRef: string,
  view: ProjectFileView,
  start: number,
  end: number,
  kind: ProjectSelection['kind'],
  label?: string,
  source: ProjectSourceCoordinates = createProjectSourceCoordinates(view.content)
): ProjectSelection {
  assertVisibleSpan(view, source, start, end)
  const startLine = sourceLineAt(source, start)
  const endLine = sourceLineAt(source, Math.max(start, end - 1))
  const lines = start === source.lines[startLine - 1].start && end === source.lines[endLine - 1].end
  const coverage = [
    {
      startOffset: start,
      endOffset: end,
      startLine,
      endLine,
      completeLines: lines,
    },
  ]
  // 目标直接保存自己的覆盖；不为每个片段再复制一条视图记录，一千处编辑也不会耗尽引用账本。
  const record: ProjectSelectionRecord = {
    fileRef,
    start,
    end,
    kind,
    lines,
    coverage,
    ...(label ? { label } : {}),
  }
  return {
    ref: saveReceipt(ctx, 'target', record),
    path: view.path,
    kind,
    ...(label ? { label } : {}),
  }
}

/** 身份来自本会话、本项目；复核存储中的范围，陈旧版本在提交时另行核对。 */
export async function loadSelection(
  ctx: ProjectOperationContext,
  value: string | ProjectSelection
): Promise<{ record: ProjectSelectionRecord; view: ProjectFileView }> {
  const record = readReceipt(ctx, 'target', selectionRef(value)) as ProjectSelectionRecord
  const view = await loadFileView(ctx, record.fileRef)
  return { record, view: { ...view, coverage: structuredClone(record.coverage) } }
}
