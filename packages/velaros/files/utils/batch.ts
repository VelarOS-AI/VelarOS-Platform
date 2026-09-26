/**
 * 读是一批文件、写是一串步骤：核对一批的条数，造读的失败条目，把写入计划交给空间落盘，造写的整批失败。
 */

import { isArray, isEmpty, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { FileErrorCodes } from '../contract/constants.js'
import type { FileEditPlan, FileEditProblem } from '../types/edit.js'
import type { FileFailure } from '../types/files.js'
import type { FileWrite } from '../types/space.js'

/** read 的一批是 files（每个文件一项），edit 的一批是 steps（每一步一项）。 */
const BatchShapes = {
  read: { key: 'files', unit: '个文件', example: "{ path: 'a.txt' }" },
  edit: { key: 'steps', unit: '步', example: "{ action: 'write', path: 'a.txt', text: '...' }" },
} as const

/**
 * 取出一批：入参来自模型的程序，形状不保证，先核对再用——files / steps 要是数组、每项是对象，空的和超过 max 项的都拒绝。
 * 每一项里的字段由调用方各自核对。
 */
export function batchItems<T = Record<string, unknown>>(
  input: unknown,
  max: number,
  operation: keyof typeof BatchShapes
): readonly T[] {
  const { key, unit, example } = BatchShapes[operation]
  const items = isPlainObject(input) ? input[key] : undefined
  if (!isArray(items))
    throw new AppError(
      'VALIDATION',
      `缺少 ${key}：${operation} 要 { ${key}: [...] }，每${unit}一项`
    )
  if (items.length < 1) throw new AppError('VALIDATION', `${key} 是空的；至少给一项`)
  if (items.length > max)
    throw new AppError(
      'VALIDATION',
      `${operation} 一次最多 ${max} ${unit}，这里给了 ${items.length} ${unit}；分几次调用`
    )
  if (!items.every((item) => isPlainObject(item)))
    throw new AppError('VALIDATION', `${operation} 的 ${key} 每一项都要是对象，例如 ${example}`)
  return items as readonly T[]
}

/** 一批里某个文件失败时的条目：路径照传入的原样，错误只留代码和说明。 */
export function failureEntry(path: string, failure: AppError): FileFailure {
  return { path, error: { code: failure.code, message: failure.message } }
}

/**
 * edit 整批写不下去时抛的错误：什么都没写。程序里只看得到 code 与 message，所以每个问题都写进 message
 * （第几步、哪个文件、为什么）；完整的问题清单另放在 context 里给宿主。
 */
export function unresolvedEditFailure(problems: readonly FileEditProblem[]): AppError {
  const denied = problems.some((problem) => problem.reason === 'denied')
  const listed = problems
    .map((problem) => `steps[${problem.step}] ${problem.path}：${problem.message}`)
    .join('；')
  return new AppError(
    denied ? FileErrorCodes.editDenied : FileErrorCodes.editUnresolved,
    `这次改动一个文件都没写，有 ${problems.length} 个问题。${listed}`,
    undefined,
    { executionOutcome: 'not-applied', problems: [...problems] }
  )
}

/** 路径是符号链接时把真正被写的目标记进结果；不是链接就原样返回。 */
export function withLinkTarget<T extends { target?: string }>(
  result: T,
  target: string,
  linked: boolean
): T {
  if (linked) result.target = target
  return result
}

/** 一份计划交给空间落盘的样子：计划时手上有原文的，落盘时核对磁盘上还是它；新建的核对它仍不存在；太大没留原文的只靠计划后那次印记核对。 */
export function writeOfPlan(plan: FileEditPlan): FileWrite {
  const write: FileWrite = { target: plan.target, bytes: plan.bytes }
  if (plan.previous) write.expected = { exists: true, bytes: plan.previous }
  else if (plan.created) write.expected = { exists: false }
  return write
}

/**
 * 落盘途中出错：空间点名了哪些已经写进去，就换成模型认得的路径写进报错；没点名说明什么都没写。
 * 已经写进去的那几个另记成一次改动，报错里给出它的号：程序可以拿去 undo，把这一批退回到改之前。
 */
export function commitFailure(
  error: unknown,
  plans: readonly FileEditPlan[],
  record: (applied: readonly FileEditPlan[]) => Nullable<string>
): AppError {
  const failure = AppError.from(error)
  const applied = isArray(failure.context.applied) ? failure.context.applied.filter(isString) : []
  const written = plans.filter((plan) => applied.includes(plan.target))
  if (isEmpty(written))
    return new AppError(failure.code, `这次改动没有写进去：${failure.message}`, error, {
      applied: [],
    })
  const changeId = record(written)
  const undo = changeId
    ? `要退回到改之前，就 undo({ changeId: '${changeId}' })`
    : '这几个文件改之前太大，没留原文，撤不回'
  const message = `这次改动只写进去了一部分——已经写入的：${written.map((plan) => plan.path).join('、')}；出错的原因：${failure.message}。${undo}；不要整次重发，先 read 一遍看现状`
  return new AppError(failure.code, message, error, { applied: written.map((plan) => plan.path) })
}
