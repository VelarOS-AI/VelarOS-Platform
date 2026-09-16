/**
 * 两个执行操作共用的治理动作：命令输出交给模型前的脱敏，沙箱落回前的写授权核对。
 * 两件事都只用宿主端口上的内核，不依赖执行操作的实例状态，所以放在这里。
 */

import { isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProjectToolContext } from '../../contract/requires.js'
import type { ProjectCommandResult } from '../../types/project.js'
import { ProjectTuning } from '../tuning.js'

/**
 * 命令输出交给模型之前过一遍项目的脱敏后端：project:run 与 project:sandbox 的 run 用同一条路，
 * 不然「在沙箱里 cat 一个私钥」就成了绕开项目读取治理的后门。宿主没有脱敏后端时原样返回。
 */
export async function redactCommandOutput<T>(context: ProjectToolContext, result: T): Promise<T> {
  const output = result as Partial<ProjectCommandResult>
  if (!isString(output?.stdout) && !isString(output?.stderr)) return result
  const kernel = await context.project.kernel()
  const stdout = isString(output.stdout) ? (await kernel.redactText({ content: output.stdout })).content : output.stdout
  const stderr = isString(output.stderr) ? (await kernel.redactText({ content: output.stderr })).content : output.stderr
  return { ...result, stdout, stderr }
}

/**
 * 落回前把完整差量里的每条路径过一遍项目的写授权（越界、writeDeny、宿主可见范围、受保护文件、生成文件）。
 * 有不许写的就在问用户之前整批拒绝：沙箱落回不经事务链，这里不拦就等于给了一条绕开写治理的路。
 */
export async function assertSandboxApplyWritable(context: ProjectToolContext, paths: readonly string[]): Promise<void> {
  if (isEmpty(paths)) return
  const kernel = await context.project.kernel()
  const blocked = (await kernel.authorizeWrites(paths)).filter((decision) => !decision.allowed)
  if (isEmpty(blocked)) return
  const listed = blocked.slice(0, ProjectTuning.execution.reportedBlockedPaths).map((decision) => `${decision.path}（${decision.reason}）`)
  const rest = blocked.length > listed.length ? `，另有 ${blocked.length - listed.length} 条` : ''
  throw new AppError(
    'VALIDATION',
    `这些路径项目不许写，整批没落：${listed.join('、')}${rest}。下一步：用 paths 点名要落的文件、把它们去掉再 apply。`,
  )
}
