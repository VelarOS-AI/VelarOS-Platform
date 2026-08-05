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
      description:
        '可选正则表达式；只保留匹配的输出行。正则非法时忽略 filter 返回全量输出并说明原因，不报错。返回里会带「命中 K/N 行」，0 命中不等于没有新增输出。',
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
      description:
        '可选正则表达式；只保留匹配的输出行。正则非法时忽略 filter 返回全量输出并说明原因，不报错。返回里会带「命中 K/N 行」，0 命中不等于没有新增输出。',
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

/** 一次 filter 应用的结果：输出本身 + 让模型能自己判断「是没输出还是没命中」的账。 */
interface BackgroundJobOutputFilterResult {
  /** 呈现给模型的输出正文（filter 未生效时 = 原始输出）。 */
  output: string
  /** filter 是否真的施加了。给了非法正则时为 false（fail-open）。 */
  applied: boolean
  /** 过滤前的行数。 */
  totalLines: number
  /** filter 命中的行数；`applied` 为 false 时等于 totalLines。 */
  matchedLines: number
  /** filter 被忽略的原因（非法正则）。 */
  ignoredReason: Nullable<string>
}

/**
 * filter 是**可用性**功能，不是校验边界：三个失败方向一律 fail-open。
 *
 * 非法正则曾经直接抛 `VALIDATION`（三个工具的文档还把这当特性写着）——模型只想瞄一眼进展，
 * 得到的是一个异常。现在忽略 filter 返回全量，并把原因带回去让模型自己修正则。
 */
function filterBackgroundJobOutput(
  output: string,
  filter?: string
): BackgroundJobOutputFilterResult {
  const totalLines = isBlank(output) ? 0 : output.split('\n').length
  const unfiltered: BackgroundJobOutputFilterResult = {
    output,
    applied: false,
    totalLines,
    matchedLines: totalLines,
    ignoredReason: null,
  }
  if (!filter?.trim() || isBlank(output)) return unfiltered

  let regexp: RegExp
  try {
    regexp = new RegExp(filter)
  } catch (error) {
    return { ...unfiltered, ignoredReason: AppError.getMessage(error) }
  }

  const matched = output.split('\n').filter((line) => regexp.test(line))
  return {
    output: matched.join('\n'),
    applied: true,
    totalLines,
    matchedLines: matched.length,
    ignoredReason: null,
  }
}

/**
 * 「本次没有新增输出」与「有新增但 filter 一行没命中」必须是两句话。
 *
 * 两者曾经都印成 `(no new output)`：子 Agent 输出了 200 行进展、`filter:'error|failed'` 一行没中，
 * 模型照文档判定「没有新增输出」→ 认为 job 停滞而去 cancel 或重派，而那 200 行已经被增量游标
 * 吞掉。现在把行数账带回去（新增 N 行 / 命中 K 行），并明写用 `mode=snapshot` 复读。
 */
function formatBackgroundJobOutput(
  snapshot: ToolBackgroundJobOutputSnapshot,
  filtered: BackgroundJobOutputFilterResult
): string {
  const header = `[${snapshot.id}] ${snapshot.kind} "${snapshot.label}" ${snapshot.status}`
  const truncationNotice = snapshot.truncated
    ? `\n[cached output truncated: omitted ${Math.max(0, Math.floor(snapshot.omittedChars ?? 0))} earlier chars]`
    : ''
  const filterNotice = filtered.ignoredReason
    ? `\n[filter ignored (invalid regex), showing all output: ${filtered.ignoredReason}]`
    : ''
  const prefix = `${header}${truncationNotice}${filterNotice}`

  if (filtered.totalLines === 0) return `${prefix}\n(no new output)`

  if (filtered.applied && filtered.matchedLines === 0)
    return `${prefix}\n(${filtered.totalLines} new line(s), 0 matched the filter — re-read with mode=snapshot or without filter to see them)`

  if (filtered.applied && filtered.matchedLines < filtered.totalLines)
    return `${prefix}\n[filter matched ${filtered.matchedLines}/${filtered.totalLines} line(s); the rest are readable with mode=snapshot]\n${filtered.output}`

  return `${prefix}\n${filtered.output}`
}

function formatBackgroundJobWaitResults(
  snapshots: readonly ToolBackgroundJobOutputSnapshot[],
  filter?: string
): string {
  if (isEmpty(snapshots)) return 'No background jobs to wait for.'
  return snapshots
    .map((snapshot) =>
      formatBackgroundJobOutput(snapshot, filterBackgroundJobOutput(snapshot.output, filter))
    )
    .join('\n\n')
}

export {
  type BackgroundJobOutputFilterResult,
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
