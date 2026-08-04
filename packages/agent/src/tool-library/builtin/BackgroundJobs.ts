import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { isBlank, isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ToolBackgroundJobOutputSnapshot } from '../KernelToolContext'

const readBackgroundJobOutputSchema = z.object({
  job_id: z.string().trim().min(1).max(180).describe(
    parameterDescription({
      description: '后台 job id。agent:dispatch 返回的 thread_id 不是 job_id；使用工具结果或后续通知中的 job id。',
    })
  ),
  mode: z
    .enum(['incremental', 'snapshot'])
    .default('incremental')
    .describe(
      parameterDescription({
        description: '读取模式。',
        values: [
          'incremental：只返回自上次读取后新增的输出，并推进读取游标。',
          'snapshot：返回当前已缓存的完整输出，不推进读取游标。',
        ],
      })
    ),
  filter: z.string().trim().min(1).max(500).optional().describe(
    parameterDescription({
      description: '可选正则表达式；只保留匹配的输出行。',
    })
  ),
})

type ReadBackgroundJobOutputInput = z.input<typeof readBackgroundJobOutputSchema>

const waitBackgroundJobsSchema = z.object({
  job_ids: z
    .array(
      z.string().trim().min(1).max(180).describe(
        parameterDescription({
          description: '后台 job id。',
        })
      )
    )
    .min(1)
    .max(20)
    .optional()
    .describe(
      parameterDescription({
        description:
          '要等待的后台 job id 列表。省略时等待当前会话内调用瞬间仍在运行的所有后台 job。',
      })
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(300_000)
    .default(120_000)
    .describe(
      parameterDescription({
        description:
          '最长等待毫秒数；超时后返回这些 job 当前状态和可读输出，而不是继续阻塞。',
      })
    ),
  filter: z.string().trim().min(1).max(500).optional().describe(
    parameterDescription({
      description: '可选正则表达式；只保留匹配的输出行。',
    })
  ),
})

type WaitBackgroundJobsInput = z.input<typeof waitBackgroundJobsSchema>

const cancelBackgroundJobSchema = z.object({
  job_id: z.string().trim().min(1).max(180).describe(
    parameterDescription({
      description: '要取消的后台 job id。',
    })
  ),
})

type CancelBackgroundJobInput = z.input<typeof cancelBackgroundJobSchema>

function filterBackgroundJobOutput(output: string, filter?: string): string {
  if (!filter?.trim() || isBlank(output)) return output

  let regexp: RegExp
  try {
    regexp = new RegExp(filter)
  } catch (error) {
    throw new AppError('VALIDATION', `Invalid background job output filter: ${String(error)}`)
  }

  return output
    .split('\n')
    .filter((line) => regexp.test(line))
    .join('\n')
}

function formatBackgroundJobOutput(
  snapshot: ToolBackgroundJobOutputSnapshot,
  output: string
): string {
  const header = `[${snapshot.id}] ${snapshot.kind} "${snapshot.label}" ${snapshot.status}`
  const truncationNotice = snapshot.truncated
    ? `\n[cached output truncated: omitted ${Math.max(0, Math.floor(snapshot.omittedChars ?? 0))} earlier chars]`
    : ''
  if (isBlank(output)) return `${header}${truncationNotice}\n(no new output)`
  return `${header}${truncationNotice}\n${output}`
}

function formatBackgroundJobWaitResults(
  snapshots: readonly ToolBackgroundJobOutputSnapshot[],
  filter?: string
): string {
  if (isEmpty(snapshots)) return 'No background jobs to wait for.'
  return snapshots
    .map((snapshot) =>
      formatBackgroundJobOutput(
        snapshot,
        filterBackgroundJobOutput(snapshot.output, filter)
      )
    )
    .join('\n\n')
}

export {
  type CancelBackgroundJobInput,
  cancelBackgroundJobSchema,
  filterBackgroundJobOutput,
  formatBackgroundJobOutput,
  formatBackgroundJobWaitResults,
  type ReadBackgroundJobOutputInput,
  readBackgroundJobOutputSchema,
  type WaitBackgroundJobsInput,
  waitBackgroundJobsSchema,
}
