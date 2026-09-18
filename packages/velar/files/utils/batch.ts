/**
 * 读和写都是一批文件：核对一批的条数，造读的失败条目，核对版本，把写入计划交给空间落盘，造写的整批失败。
 */

import { isArray, isEmpty, isPlainObject, isPresent, isString, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { FileErrorCodes } from '../contract/constants.js'
import type { FileEditPlan, FileEditProblem } from '../types/edit.js'
import type { FileFailure } from '../types/files.js'
import type { FileWrite } from '../types/space.js'

/**
 * 取出一批文件：入参来自模型的程序，形状不保证，先核对再用——files 要是数组、每项是对象，空的和超过 max 个的都拒绝。
 * 每一项里的字段由调用方各自核对；operation 只用来写进报错。
 */
export function batchItems<T>(input: unknown, max: number, operation: string): readonly T[] {
  const files = isPlainObject(input) ? input.files : undefined
  if (!isArray(files)) throw new AppError('VALIDATION', `缺少 files：${operation} 要 { files: [...] }，每个文件一项`)
  if (files.length < 1) throw new AppError('VALIDATION', 'files 是空的；至少给一个文件')
  if (files.length > max) throw new AppError('VALIDATION', `${operation} 一次最多 ${max} 个文件，这里给了 ${files.length} 个；分几次调用`)
  if (!files.every((file) => isPlainObject(file))) throw new AppError('VALIDATION', `${operation} 的 files 每一项都要是对象，例如 { path: 'a.txt' }`)
  return files as readonly T[]
}

/** 一批里某个文件失败时的条目：路径照传入的原样，错误只留代码和说明。 */
export function failureEntry(path: string, failure: AppError): FileFailure {
  return { path, error: { code: failure.code, message: failure.message } }
}

/**
 * edit 整批写不下去时抛的错误：什么都没写。程序里只看得到 code 与 message，所以每个问题都写进 message
 * （第几个文件、为什么、版本对不上时现在是哪个版本）；完整的问题清单另放在 context 里给宿主。
 */
export function unresolvedEditFailure(problems: readonly FileEditProblem[]): AppError {
  const denied = problems.some((problem) => problem.reason === 'denied')
  const listed = problems.map((problem) => `files[${problem.file}] ${problem.path}：${problem.message}`).join('；')
  return new AppError(
    denied ? FileErrorCodes.editDenied : FileErrorCodes.editUnresolved,
    `这一批一个文件都没写，有 ${problems.length} 个问题。${listed}`,
    undefined,
    { executionOutcome: 'not-applied', problems: [...problems] }
  )
}

/** 核对调用方给的版本和文件现在的版本：给了且对不上就返回一条 stale 问题的字段，其余情况返回 null。文件不存在时当前版本为 null。 */
export function staleProblem(expected: Optional<string>, current: Nullable<string>): Nullable<Pick<FileEditProblem, 'reason' | 'message' | 'currentVersion'>> {
  if (!isPresent(expected) || expected === current) return null
  return {
    reason: 'stale',
    message: current
      ? `文件在版本 ${expected} 之后被改过，现在是 ${current}；重新读一遍再改`
      : `给了版本 ${expected}，但文件不存在`,
    currentVersion: toOptional(current),
  }
}

/** 路径是符号链接时把真正被写的目标记进结果；不是链接就原样返回。 */
export function withLinkTarget<T extends { target?: string }>(result: T, target: string, linked: boolean): T {
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
export function commitFailure(error: unknown, plans: readonly FileEditPlan[], record: (applied: readonly FileEditPlan[]) => Nullable<string>): AppError {
  const failure = AppError.from(error)
  const applied = isArray(failure.context.applied) ? failure.context.applied.filter(isString) : []
  const written = plans.filter((plan) => applied.includes(plan.target))
  if (isEmpty(written)) return new AppError(failure.code, `这一批没有写进去：${failure.message}`, error, { applied: [] })
  const changeId = record(written)
  const undo = changeId ? `要退回到改之前，就 undo({ changeId: '${changeId}' })` : '这几个文件改之前太大，没留原文，撤不回'
  const message = `这一批只写进去了一部分——已经写入的：${written.map((plan) => plan.path).join('、')}；出错的原因：${failure.message}。${undo}；不要整批重发，先 read 一遍看现状`
  return new AppError(failure.code, message, error, { applied: written.map((plan) => plan.path) })
}
