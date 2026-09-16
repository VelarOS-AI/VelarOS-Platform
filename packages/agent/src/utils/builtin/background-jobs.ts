// 域：`job:*` 三个工具的模型面入参形状与输出渲染。
//
// 只放 schema 与纯函数：真去读、去等、去取消后台任务的编排在 impl/builtin/BackgroundJobOperations.ts。
import { z } from 'zod'

import { isBlank, isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { AgentToolLimits } from '../../contract/constants.js'
import type { BackgroundJobOutputFilterResult, CancelBackgroundJobInput,ReadBackgroundJobOutputInput, WaitBackgroundJobsInput } from '../../types/builtin.js'
import type { ToolBackgroundJobOutputSnapshot } from '../../types/tool-context.js'
import {
  renderParameterDescription as parameterDescription,
} from '../toolkit/tool-description'

export const readBackgroundJobOutputSchema: z.ZodType<ReadBackgroundJobOutputInput> = z.object({
  job_id: z.string().trim().min(1).max(AgentToolLimits.jobs.jobIdChars).describe(
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
  filter: z.string().trim().min(1).max(AgentToolLimits.jobs.outputFilterChars).optional().describe(
    parameterDescription({
      description:
        '可选正则表达式；只保留匹配的输出行。正则非法时忽略 filter 返回全量输出并说明原因，不报错。返回里会带「命中 K/N 行」，0 命中不等于没有新增输出。',
    })
  ),
})

export const waitBackgroundJobsSchema: z.ZodType<WaitBackgroundJobsInput> = z.object({
  job_ids: z
    .array(
      z.string().trim().min(1).max(AgentToolLimits.jobs.jobIdChars).describe(
        parameterDescription({
          description: '后台 job id。',
        })
      )
    )
    .min(1)
    .max(AgentToolLimits.jobs.maxWaitJobIds)
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
    .max(AgentToolLimits.jobs.maxWaitTimeoutMs)
    .default(AgentToolLimits.jobs.defaultWaitTimeoutMs)
    .describe(
      parameterDescription({
        description:
          '最长等待毫秒数；超时后返回这些 job 当前状态和可读输出，而不是继续阻塞。',
      })
    ),
  filter: z.string().trim().min(1).max(AgentToolLimits.jobs.outputFilterChars).optional().describe(
    parameterDescription({
      description:
        '可选正则表达式；只保留匹配的输出行。正则非法时忽略 filter 返回全量输出并说明原因，不报错。返回里会带「命中 K/N 行」，0 命中不等于没有新增输出。',
    })
  ),
})

export const cancelBackgroundJobSchema: z.ZodType<CancelBackgroundJobInput> = z.object({
  job_id: z.string().trim().min(1).max(AgentToolLimits.jobs.jobIdChars).describe(
    parameterDescription({
      description: '要取消的后台 job id。',
    })
  ),
})

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
 * 两者曾经都印成「没有新增输出」：子 Agent 输出了 200 行进展、`filter:'error|failed'` 一行没中，
 * 模型照文档判定「没有新增输出」→ 认为 job 停滞而去 cancel 或重派，而那 200 行已经被增量游标
 * 吞掉。现在把行数账带回去（新增 N 行 / 命中 K 行），并明写用 `mode=snapshot` 复读。
 */
function formatBackgroundJobOutput(
  snapshot: ToolBackgroundJobOutputSnapshot,
  filtered: BackgroundJobOutputFilterResult
): string {
  const header = `[${snapshot.id}] ${snapshot.kind} "${snapshot.label}" ${snapshot.status}`
  const truncationNotice = snapshot.truncated
    ? `\n[缓存输出已截断：更早的 ${Math.max(0, Math.floor(snapshot.omittedChars ?? 0))} 个字符被省略]`
    : ''
  const filterNotice = filtered.ignoredReason
    ? `\n[filter 是无效正则，已忽略并返回全量输出：${filtered.ignoredReason}]`
    : ''
  const prefix = `${header}${truncationNotice}${filterNotice}`

  if (filtered.totalLines === 0) return `${prefix}\n（没有新增输出）`

  if (filtered.applied && filtered.matchedLines === 0)
    return `${prefix}\n（新增 ${filtered.totalLines} 行，但一行都没命中 filter——用 mode=snapshot 或去掉 filter 复读就能看到）`

  if (filtered.applied && filtered.matchedLines < filtered.totalLines)
    return `${prefix}\n[filter 命中 ${filtered.matchedLines}/${filtered.totalLines} 行；其余用 mode=snapshot 可读]\n${filtered.output}`

  return `${prefix}\n${filtered.output}`
}

/** 把一批等待结果逐个渲染后拼起来；一个都没有时直接说没有要等的任务。 */
function formatBackgroundJobWaitResults(
  snapshots: readonly ToolBackgroundJobOutputSnapshot[],
  filter?: string
): string {
  if (isEmpty(snapshots)) return '没有需要等待的后台任务。'
  return snapshots
    .map((snapshot) =>
      formatBackgroundJobOutput(snapshot, filterBackgroundJobOutput(snapshot.output, filter))
    )
    .join('\n\n')
}

export { filterBackgroundJobOutput, formatBackgroundJobOutput, formatBackgroundJobWaitResults }
