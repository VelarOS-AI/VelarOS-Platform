/**
 * 按路径的编辑步骤换成编辑规划认的步骤：模型只写路径与正文，读取凭据由这里取。
 * 已有的文件在这里整份读一次、拿覆盖整个文件的 fileRef；本次前面的步骤新建的文件按路径指；
 * 改过、移过的文件按同一个原 fileRef 指（sourceRef），内容按前面的步骤改完之后的算；
 * 前面的步骤移走、删掉的路径在这次改动里就没有了，不再去读磁盘上还在的那份。
 * 一步对一步：失败说明里的步号就是模型写的步号。
 */

import { isString, isTrue, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ProjectPolicyDefaults } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type { ProjectEditStep, ProjectPlanStep, ProjectStepSource } from '../../types/files.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

import { isAgentProjectError, readAgentFile } from './kernel-port.js'
import { projectRelativePath } from './ports.js'
import { finalizeFileWindows, presentFileRead } from './source-window.js'

/** 按路径整份读一次，交回覆盖整个文件的 fileRef；文件不存在交回 undefined，目录、二进制、太大改不了的直接说。 */
async function wholeFileRef(ctx: ProjectOperationContext, path: string): Promise<Optional<string>> {
  const kernel = await ctx.project.kernel()
  let file: Awaited<ReturnType<typeof readAgentFile>>
  try {
    file = await readAgentFile(kernel, { path, maxChars: ProjectTuning.agent.fullReadChars })
  } catch (error) {
    if (isAgentProjectError(error, 'TARGET_NOT_FOUND')) return undefined
    throw error
  }
  if (isTrue(file.truncated))
    throw new ProjectError(
      'SCOPE_VIOLATION',
      `${path} 太大，整份读不全，改不了。`,
      { path },
      '用命令处理它，或者先把文件拆小。'
    )
  const [signed] = await finalizeFileWindows(ctx, [await presentFileRead(ctx, file)])
  if (isString(signed?.fileRef)) return signed.fileRef
  if (isString(signed?.referenceUnavailable))
    throw new ProjectError(
      'NOT_SUPPORTED',
      `${path} 超过可编辑的上限（${Math.floor(ProjectPolicyDefaults.maxFileSizeToReadBytes / 1024 / 1024)} MiB），改不了。`,
      { path },
      '用命令处理它，或者先把文件拆小。'
    )
  // 签不出来只剩一种情况：整份读的时候文件正被别处改。
  throw new ProjectError(
    'BASE_REVISION_MISMATCH',
    `${path} 读的时候正被别处改，这次没改成。`,
    { path },
    '重新提交这次 edit。'
  )
}

/** 一步里抛出来的错误补上是第几步：项目错误记进 details（失败说明按它写 steps[i]），空间抛的通用错误写在 message 前面。 */
function atStep(error: unknown, stepIndex: number): unknown {
  if (error instanceof ProjectError)
    return new ProjectError(
      error.reason,
      error.message,
      { ...error.details, stepIndex },
      error.suggestedNextAction
    )
  if (error instanceof AppError)
    return new AppError(error.code, `steps[${stepIndex}]：${error.message}`, error, error.context)
  return error
}

/** 按路径的步骤换成编辑规划的步骤：路径钳在项目内，读取凭据由这里取。 */
export async function planPathSteps(
  steps: readonly ProjectEditStep[],
  ctx: ProjectOperationContext
): Promise<ProjectPlanStep[]> {
  // 现在的路径 → 这个文件的原 fileRef（改过、移过之后仍指同一份原文件）；用过一次的原 fileRef 再指它写成 sourceRef。
  const refs = new Map<string, string>()
  const used = new Set<string>()
  const created = new Set<string>()
  // 本次前面的步骤移走、删掉的路径：磁盘上还在，这次改动里已经没有了。
  const vacated = new Set<string>()
  const lookup = async (path: string): Promise<Optional<string>> => {
    if (!refs.has(path) && !created.has(path) && !vacated.has(path)) {
      const ref = await wholeFileRef(ctx, path)
      if (isString(ref)) refs.set(path, ref)
    }
    return refs.get(path)
  }
  const source = async (path: string): Promise<ProjectStepSource> => {
    if (created.has(path)) return { path }
    const ref = await lookup(path)
    if (isUndefined(ref))
      throw new ProjectError(
        'TARGET_NOT_FOUND',
        vacated.has(path) ? `${path} 已经被本次前面的步骤移走或删掉了。` : `${path} 不存在。`,
        { path },
        '先 list 出准确的路径；要新建文件就用 write。'
      )
    if (used.has(ref)) return { sourceRef: ref }
    used.add(ref)
    return { fileRef: ref }
  }
  // 路径空出来了：它原来的内容跟着移走或删掉，这次改动里再写它就是新建。
  const vacate = (path: string) => {
    refs.delete(path)
    created.delete(path)
    vacated.add(path)
  }
  const plan: ProjectPlanStep[] = []
  for (const [stepIndex, step] of steps.entries()) {
    ctx.abortSignal.throwIfAborted()
    try {
      if (step.action === 'recode') {
        const paths: string[] = []
        for (const path of step.paths) paths.push(await projectRelativePath(ctx, path))
        plan.push({ ...step, paths })
        continue
      }
      const path = await projectRelativePath(ctx, step.path)
      if (step.action === 'write') {
        if (created.has(path) || isString(await lookup(path)))
          plan.push({
            action: 'overwrite',
            text: step.text,
            expectedText: step.expectedText,
            ...(await source(path)),
          })
        else {
          plan.push({ action: 'create', path, text: step.text, expectedText: step.expectedText })
          created.add(path)
          vacated.delete(path)
        }
      } else if (step.action === 'replace') {
        plan.push({
          action: 'edit',
          edits: [{ op: 'replace', match: step.oldText, text: step.newText }],
          ...(await source(path)),
        })
      } else if (step.action === 'move') {
        const to = await projectRelativePath(ctx, step.to)
        plan.push({ action: 'move', to, ...(await source(path)) })
        const ref = refs.get(path)
        const wasCreated = created.has(path)
        vacate(path)
        vacated.delete(to)
        if (isString(ref)) refs.set(to, ref)
        if (wasCreated) created.add(to)
      } else {
        plan.push({ action: 'delete', ...(await source(path)) })
        vacate(path)
      }
    } catch (error) {
      throw atStep(error, stepIndex)
    }
  }
  return plan
}
