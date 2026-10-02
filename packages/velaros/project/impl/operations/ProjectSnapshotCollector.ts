import { createHash } from 'node:crypto'

import { isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ProjectSnapshotLimits } from '../../contract/constants.js'
import type { AgentProjectKernelPort, ProjectOperationContext } from '../../contract/requires.js'
import type {
  ProjectSnapshotCapture as Snapshot,
  ProjectSnapshotFile,
  ProjectSnapshotInput,
} from '../../types/observation.js'
import { readAgentFile } from '../../utils/agent/kernel-port.js'
import { projectRelativePath } from '../../utils/agent/ports.js'
import { snapshotInput } from '../../utils/agent/snapshot-input.js'
import { readLineRange } from '../../utils/editing/line-range.js'

/** 当前领域操作拥有的纯值捕获；不签发写入凭据、不以文件时间戳证明相等。 */
export interface ProjectSnapshotCollectorApi {
  /** 在已有领域读门内前后捕获相同资源，任何缺口都拒绝完整回执。 */
  capture(input: ProjectSnapshotInput, ctx: ProjectOperationContext): Promise<Snapshot>
}

export class ProjectSnapshotCollector implements ProjectSnapshotCollectorApi {
  private readonly incarnations = new WeakMap<AgentProjectKernelPort, string>()

  public async capture(
    input: ProjectSnapshotInput,
    ctx: ProjectOperationContext
  ): Promise<Snapshot> {
    const plan = snapshotInput(input)
    const kernel = await ctx.project.kernel()
    const root = ctx.project.getRootPath()
    let providerId = this.incarnations.get(kernel)
    if (!providerId) {
      providerId = crypto.randomUUID()
      this.incarnations.set(kernel, providerId)
    }
    let readRequests = 0
    let materialBytes = 0
    const collect = async (): Promise<ProjectSnapshotFile[]> => {
      let remaining: number = ProjectSnapshotLimits.chars
      const files: ProjectSnapshotFile[] = []
      for (const item of plan.files) {
        ctx.abortSignal.throwIfAborted()
        const path = await projectRelativePath(ctx, item.path)
        const range = readLineRange(item.range)
        readRequests++
        const result = await readAgentFile(kernel, { path, range, maxChars: remaining })
        if (isString(result.content)) materialBytes += Buffer.byteLength(result.content, 'utf8')
        ctx.abortSignal.throwIfAborted()
        if (result.truncated || !isString(result.content) || !result.snapshot.revision)
          throw new AppError('LIMIT', 'snapshot 请求范围没有被完整捕获')
        remaining -= [...result.content].length
        if (remaining < 0) throw new AppError('LIMIT', 'snapshot 正文超过完整捕获上限')
        const file: { -readonly [Key in keyof ProjectSnapshotFile]: ProjectSnapshotFile[Key] } = {
          path: result.snapshot.path,
          revision: result.snapshot.revision,
          text: result.content,
          startLine: result.range?.startLine ?? range?.startLine ?? 1,
        }
        if (!isUndefined(result.totalLines)) file.totalLines = result.totalLines
        files.push(file)
      }
      return files
    }
    try {
      const before = await collect()
      const after = await collect()
      if (
        root !== ctx.project.getRootPath() ||
        kernel !== (await ctx.project.kernel()) ||
        JSON.stringify(before) !== JSON.stringify(after)
      )
        throw new AppError('CONFLICT', 'snapshot 前后捕获或项目绑定已经变化，重新采集')
      ctx.abortSignal.throwIfAborted()
      ctx.recordSnapshotCompletion?.()
      return {
        providerId,
        root,
        complete: true,
        value: { files: after },
        checkedAt: new Date().toISOString(),
        readRequests,
        materialBytes,
        fingerprint: createHash('sha256').update(JSON.stringify(after)).digest('hex'),
      }
    } catch (error) {
      ctx.recordSnapshotMetrics?.({ readRequests, materialBytes })
      const failure = AppError.from(error)
      throw AppError.withFields(failure.code, failure.message, {
        snapshotCapture: { readRequests, materialBytes },
      })
    }
  }
}
