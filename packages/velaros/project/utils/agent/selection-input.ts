/** 目标与批量编辑入参核对；坐标始终从签发记录读取。 */
import { isPlainObject } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type {
  ProjectPatchDraft,
  ProjectPatchEdit,
  ProjectSelectTarget,
} from '../../types/selection.js'
import { ProjectError } from '../errors.js'
import { assertWellFormedProjectText } from '../text.js'

import { readReceipt } from './file-refs.js'
import { selectionRef } from './selection-refs.js'

/** 非空数组及对象形状的错误统一用领域原因码。 */
function invalid(message: string): never {
  throw new ProjectError('INVALID_INPUT', message)
}

/** 只接受互斥的路径/目标和结构/字面定位，禁止静默忽略错误字段。 */
export function selectInput(input: unknown): ProjectSelectTarget[] {
  if (
    !isPlainObject(input) ||
    !Array.isArray(input.targets) ||
    input.targets.length < 1 ||
    input.targets.length > ProjectFileLimits.selectTargets
  )
    return invalid(`targets 要 1–${ProjectFileLimits.selectTargets} 项。`)
  return input.targets.map((item, index) => {
    if (
      !isPlainObject(item) ||
      'path' in item === 'within' in item ||
      'symbol' in item === 'match' in item
    )
      return invalid(`targets[${index}] 的 path/within、symbol/match 各选一个。`)
    if ('path' in item && (typeof item.path !== 'string' || !item.path.trim()))
      return invalid(`targets[${index}].path 要非空路径。`)
    if ('within' in item) selectionRef(item.within)
    const locator = 'symbol' in item ? item.symbol : item.match
    if (typeof locator !== 'string' || locator.length === 0)
      return invalid(`targets[${index}] 要非空 symbol 或 match。`)
    assertWellFormedProjectText(locator)
    return item as ProjectSelectTarget
  })
}

/** 一项只替换工具目标或在其前后插入；正文必须是完整 Unicode 字符串。 */
function patchEdit(value: unknown, index: number): ProjectPatchEdit {
  if (!isPlainObject(value)) return invalid(`edits[${index}] 要目标和 text。`)
  selectionRef(value.target)
  if (typeof value.text !== 'string') return invalid(`edits[${index}].text 要新正文字符串。`)
  assertWellFormedProjectText(value.text)
  if (value.op !== undefined && !['replace', 'before', 'after'].includes(String(value.op)))
    return invalid(`edits[${index}].op 只收 replace、before、after。`)
  return {
    target: value.target as ProjectPatchEdit['target'],
    text: value.text,
    ...(value.op ? { op: value.op as ProjectPatchEdit['op'] } : {}),
  }
}

/** 校验新批次或从未提交计划增量恢复；保留 null 槽，失败项下标不会变化。 */
export function patchInput(
  input: unknown,
  ctx: ProjectOperationContext
): { draft: ProjectPatchDraft; previous?: string } {
  if (!isPlainObject(input) || 'edits' in input === 'planRef' in input)
    return invalid('patch 要 edits，或 planRef 加 amendments。')
  if (input.receipt !== undefined && input.receipt !== 'summary' && input.receipt !== 'full')
    return invalid('receipt 只收 summary 或 full。')
  if ('edits' in input) {
    if (
      'amendments' in input ||
      !Array.isArray(input.edits) ||
      input.edits.length < 1 ||
      input.edits.length > ProjectFileLimits.steps
    )
      return invalid(`edits 要 1–${ProjectFileLimits.steps} 项。`)
    return { draft: { edits: input.edits.map(patchEdit), receipt: input.receipt ?? 'summary' } }
  }
  if (typeof input.planRef !== 'string') return invalid('planRef 要失败回执签发的计划引用。')
  const original = readReceipt(ctx, 'plan', input.planRef) as ProjectPatchDraft
  if (!Array.isArray(input.amendments) || input.amendments.length > ProjectFileLimits.steps)
    return invalid(`amendments 要最多 ${ProjectFileLimits.steps} 项。`)
  const edits = structuredClone(original.edits)
  const seen = new Set<number>()
  for (const item of input.amendments) {
    if (
      !isPlainObject(item) ||
      !Number.isSafeInteger(item.index) ||
      Number(item.index) < 0 ||
      Number(item.index) >= edits.length ||
      seen.has(Number(item.index))
    )
      return invalid('amendments 的 index 必须是原 edits 中互不重复的下标。')
    const index = Number(item.index)
    seen.add(index)
    edits[index] = item.edit === null ? null : patchEdit(item.edit, index)
  }
  if (edits.every((edit) => edit === null)) return invalid('计划必须保留至少一项编辑。')
  return { draft: { edits, receipt: input.receipt ?? original.receipt }, previous: input.planRef }
}
