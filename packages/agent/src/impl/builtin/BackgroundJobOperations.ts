import { AppError } from '@velaros-ai/core/error'

import { AgentToolLimits } from '../../contract/constants.js'
import type { CancelBackgroundJobInput, ReadBackgroundJobOutputInput, WaitBackgroundJobsInput } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { describeMissingBackgroundJob, filterBackgroundJobOutput, formatBackgroundJobOutput, formatBackgroundJobWaitResults } from '../../utils/builtin/background-jobs'

/**
 * 后台作业三个工具（`job:read_output` / `job:wait` / `job:cancel`）的执行面。
 *
 * 三个动作都只经工具上下文上的后台作业端口，且只看得到当前会话拥有的作业。
 * 端口缺席时抛 `VALIDATION`（工具的 isAvailable 已经先挡了一层，这里是绕过 schema 直调时的兜底）。
 * 整个进程一份，自身不持有状态。
 */
export interface BackgroundJobOperationsApi {
  /** 读一个后台作业的增量或完整输出；作业不在本会话时回一句中文说明，不抛错。 */
  readOutput(input: ReadBackgroundJobOutputInput, ctx: KernelToolContext): Promise<string>
  /** 等一批后台作业收尾；超时返回当前状态与当前可读输出。 */
  wait(input: WaitBackgroundJobsInput, ctx: KernelToolContext): Promise<string>
  /** 取消一个后台作业并回带它的最终输出；作业不在本会话时回一句中文说明，不抛错。 */
  cancel(input: CancelBackgroundJobInput, ctx: KernelToolContext): Promise<string>
}

class BackgroundJobOperations implements BackgroundJobOperationsApi {
  /** 端口缺席时给的三句说明，按动作分。 */
  private static readonly UnavailableMessages = {
    read: '后台 job 输出读取当前不可用。',
    wait: '后台 job 等待当前不可用。',
    cancel: '后台 job 取消当前不可用。',
  } as const

  public async readOutput(input: ReadBackgroundJobOutputInput, ctx: KernelToolContext): Promise<string> {
    const readBackgroundJobOutput = ctx.readBackgroundJobOutput
    if (!readBackgroundJobOutput) throw new AppError('VALIDATION', BackgroundJobOperations.UnavailableMessages.read)

    const snapshot = await readBackgroundJobOutput({
      jobId: input.job_id,
      mode: input.mode ?? 'incremental',
    })
    if (!snapshot) return describeMissingBackgroundJob(input.job_id)
    return formatBackgroundJobOutput(snapshot, filterBackgroundJobOutput(snapshot.output, input.filter))
  }

  public async wait(input: WaitBackgroundJobsInput, ctx: KernelToolContext): Promise<string> {
    const waitBackgroundJobs = ctx.waitBackgroundJobs
    if (!waitBackgroundJobs) throw new AppError('VALIDATION', BackgroundJobOperations.UnavailableMessages.wait)

    const snapshots = await waitBackgroundJobs({
      jobIds: input.job_ids,
      timeoutMs: input.timeout_ms ?? AgentToolLimits.jobs.defaultWaitTimeoutMs,
    })
    return formatBackgroundJobWaitResults(snapshots, input.filter)
  }

  public async cancel(input: CancelBackgroundJobInput, ctx: KernelToolContext): Promise<string> {
    const cancelBackgroundJob = ctx.cancelBackgroundJob
    if (!cancelBackgroundJob) throw new AppError('VALIDATION', BackgroundJobOperations.UnavailableMessages.cancel)

    const snapshot = await cancelBackgroundJob({ jobId: input.job_id })
    if (!snapshot) return describeMissingBackgroundJob(input.job_id)
    return formatBackgroundJobOutput(snapshot, filterBackgroundJobOutput(snapshot.output))
  }

}

/** 进程内唯一一份后台作业执行面；工具文件按它一行委托。 */
export const backgroundJobOperations: BackgroundJobOperationsApi = new BackgroundJobOperations()
