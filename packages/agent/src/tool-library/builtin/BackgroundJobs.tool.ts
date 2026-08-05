import { AppError } from '@velaros-ai/core/error'

import { defineVelaTool } from '../defineVelaTool'

import {
  type CancelBackgroundJobInput,
  cancelBackgroundJobSchema,
  filterBackgroundJobOutput,
  formatBackgroundJobOutput,
  formatBackgroundJobWaitResults,
  type ReadBackgroundJobOutputInput,
  readBackgroundJobOutputSchema,
  type WaitBackgroundJobsInput,
  waitBackgroundJobsSchema,
} from './BackgroundJobs'

const readBackgroundJobOutput = defineVelaTool<ReadBackgroundJobOutputInput>({
  name: 'job:read_output',
  role: 'control',
  category: 'agent-control',
  summary: '读取当前会话内核后台 job 的新增或完整输出。',
  suitable: [
    'agent:dispatch 已启动可等待子 Agent job，后续需要查看其结果或错误输出。',
    '后台 job 通知提示任务完成、失败或可能停滞，需要检查输出后再继续。',
    '需要非阻塞地轮询后台任务输出，而不是 sleep 或重复派发同一任务。',
  ],
  forbidden: [
    '不要用它读取系统 shell 命令历史；系统后台命令仍使用 system:list-tasks。',
    '不要在没有 job_id 时猜测；先从 agent:dispatch 返回或后台通知中取得 job id。',
  ],
  usage: [
    '默认 mode=incremental，只返回新增输出并推进游标；需要完整缓存时用 mode=snapshot。',
    'filter 是正则表达式，只保留匹配行；正则无效会被忽略（返回全量输出并说明原因），不会报错。',
    '「no new output」= 本次真的没有新增；「N new line(s), 0 matched the filter」= 有新增但一行没命中，此时用 mode=snapshot 或去掉 filter 复读。两者都不代表 job 不存在。',
  ],
  examples: [
    {
      job_id: 'subagent:abc:background:123',
      mode: 'incremental',
      filter: 'error|failed|summary',
    },
  ],
  notes: [
    '该工具只访问当前会话拥有的内核后台 job；跨会话或不存在的 job 会返回 not found。',
    '它不等待任务完成；需要等待外部条件（端口/HTTP/文件）时用 bash 轮询（如 curl/test -f 循环）。',
  ],
  schema: readBackgroundJobOutputSchema,
  permissions: [],
  isAvailable: (ctx) => !!ctx.readBackgroundJobOutput,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    if (!ctx.readBackgroundJobOutput) {
      throw new AppError('VALIDATION', '后台 job 输出读取当前不可用。')
    }

    const snapshot = await ctx.readBackgroundJobOutput({
      jobId: input.job_id,
      mode: input.mode ?? 'incremental',
    })
    if (!snapshot) return `Background job "${input.job_id}" was not found for this session.`

    return formatBackgroundJobOutput(
      snapshot,
      filterBackgroundJobOutput(snapshot.output, input.filter)
    )
  },
})

const waitBackgroundJobs = defineVelaTool<WaitBackgroundJobsInput>({
  name: 'job:wait',
  role: 'control',
  category: 'agent-control',
  summary: '等待当前会话内核后台 job 完成并返回结果。',
  suitable: [
    'agent:dispatch 已启动一个或多个可等待子 Agent job，需要在继续决策前收束它们的结果。',
    '后台 job 仍在运行，但下一步依赖其最终输出，应该等待而不是手动轮询。',
    '需要一次性等待当前会话内所有已运行后台 job，可省略 job_ids。',
  ],
  forbidden: [
    '不要用它等待普通系统命令；系统后台命令用 system:list-tasks 或系统任务工具。',
    '不要把 thread_id 当 job_id；job_id 来自 agent:dispatch 返回或后台通知。',
  ],
  usage: [
    '提供 job_ids 时只等待当前会话拥有且匹配的 job；跨会话或不存在的 id 会被忽略。',
    '省略 job_ids 时等待调用瞬间当前会话内仍在运行的所有后台 job。',
    'timeout_ms 到期时返回当前状态和当前可读输出；返回 running 表示仍未完成。',
    'filter 是正则表达式，只保留匹配行；正则无效会被忽略（返回全量输出并说明原因），不会报错。',
  ],
  examples: [
    {
      job_ids: ['subagent:abc:background:123'],
      timeout_ms: 30_000,
      filter: 'summary|error|failed',
    },
  ],
  notes: [
    '该工具只访问当前会话拥有的内核后台 job；不读取其他会话任务。',
    '它和 job:read_output 使用同一个输出源，artifact-backed 输出可完整读取。',
  ],
  schema: waitBackgroundJobsSchema,
  permissions: [],
  isAvailable: (ctx) => !!ctx.waitBackgroundJobs,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    if (!ctx.waitBackgroundJobs) {
      throw new AppError('VALIDATION', '后台 job 等待当前不可用。')
    }

    const snapshots = await ctx.waitBackgroundJobs({
      jobIds: input.job_ids,
      timeoutMs: input.timeout_ms ?? 120_000,
    })
    return formatBackgroundJobWaitResults(snapshots, input.filter)
  },
})

const cancelBackgroundJob = defineVelaTool<CancelBackgroundJobInput>({
  name: 'job:cancel',
  role: 'control',
  category: 'agent-control',
  summary: '取消当前会话内核后台 job。',
  suitable: [
    'agent:dispatch 启动的后台子 Agent 已不需要继续运行。',
    '后台 job 可能卡住或处理了错误方向，需要按 job id 中断。',
    '后台通知提示 job 仍在运行，而用户或主任务已经切换目标。',
  ],
  forbidden: [
    '不要用它取消系统后台命令；系统后台命令使用对应系统任务工具。',
    '不要猜测 job_id；先从 agent:dispatch 返回或后台通知中取得 job id。',
  ],
  usage: [
    '只取消当前会话拥有的 job；跨会话或不存在的 job 会返回 not found。',
    '取消 async 子 Agent job 会向对应 worker 发送中断信号。',
    '已完成或已失败的 job 不会重新运行，返回其当前状态。',
  ],
  examples: [
    {
      job_id: 'subagent:abc:background:123',
    },
  ],
  notes: [
    '取消后可用 job:read_output 或 job:wait 查看最终可读输出。',
  ],
  schema: cancelBackgroundJobSchema,
  permissions: [],
  isAvailable: (ctx) => !!ctx.cancelBackgroundJob,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    if (!ctx.cancelBackgroundJob) {
      throw new AppError('VALIDATION', '后台 job 取消当前不可用。')
    }

    const snapshot = await ctx.cancelBackgroundJob({ jobId: input.job_id })
    if (!snapshot) return `Background job "${input.job_id}" was not found for this session.`
    return formatBackgroundJobOutput(snapshot, filterBackgroundJobOutput(snapshot.output))
  },
})

const backgroundJobTools = {
  'job:cancel': cancelBackgroundJob,
  'job:read_output': readBackgroundJobOutput,
  'job:wait': waitBackgroundJobs,
}

export { backgroundJobTools }
