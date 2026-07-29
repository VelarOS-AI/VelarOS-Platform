import { AppError } from '@velaros-ai/core/error'

import { defineVelaTool } from '../defineVelaTool'

import type { DispatchAgentInput } from './DispatchAgent'
import { dispatchAgentSchema } from './DispatchAgent'

const dispatchAgent = defineVelaTool<DispatchAgentInput>({
  name: 'dispatch_agent',
  role: 'control',
  category: 'general',
  summary: '在当前执行作用域中派发独立 sub-agent。',
  suitable: [
    '仅复杂任务：并行探索多目录/方案，或单条子任务本身就需很多步。',
    '并行处理可独立完成、无需实时共享中间状态的子任务。',
  ],
  forbidden: [
    '默认不派：简单/单步任务（读文件、跑命令）自己直接做，更快。',
    '工具调不出时用 tool_map/tool_replace 换入自用，别拿子 Agent 绕过。',
    '不派彼此实时同步的串行任务；子 Agent 不能再派子 Agent。',
    '不要用子 Agent 绕过宿主的能力、权限或作用域边界。',
  ],
  usage: [
    '同一轮可多次调用 dispatch_agent 实现并行；系统会自动限制并发数。',
    'subagent_type 必须来自运行时公开的 SubAgentTypeProvider；类型决定默认工具与只读策略。',
    'mode=sync（默认）会阻塞到子 Agent 完成、直接把结果内联返回——主链路需要该结果才能继续时用它，不要再调 wait_background_jobs，也不要因为没立刻拿到就重派。',
    'mode=async 后台 fire-and-forget，立即返回可等待 job；父 Agent 先继续非重叠工作，之后用 read_background_job_output/wait_background_jobs 主动收束。',
    'thread_id 续跑已有 worker；interrupt 配合 thread_id 中断运行中 worker。',
    'agent_name 必须是英文代号名，不要带数字，例如 Atlas、Forge、Scout、Beacon。',
    'tool_scope 可用 type_default、inherit 或 custom；custom 时填写 tool_categories。',
    'effort 覆盖子 Agent 思考力度（fast/balanced/deep），省略即继承会话档；机械子任务压 fast 省钱提速，难题给 deep。',
    'output_schema 让子 Agent 强制回结构化 JSON（校验不符自动重试），结果在 structured_output 字段——需要机器可读结果时用，免去再解析散文。',
    'prompt 必须自洽：写清目标、已知事实、范围边界、成功标准和输出长度；不要把理解外包给子 Agent，主 Agent 负责综合与收口。description 用于 UI 展示。',
  ],
  examples: [
    // 同步只读探索（默认 mode:sync，返回后再继续）
    {
      agent_name: 'Scout',
      subagent_type: 'explore',
      tool_scope: 'type_default',
      description: 'Scan auth module',
      prompt: 'Read src/auth and summarize login flow, key files, and risks.',
    },
    // 异步后台任务：mode:async，父 Agent 先继续，之后用 wait_background_jobs/read_background_job_output 收束
    {
      agent_name: 'Builder',
      subagent_type: 'general',
      tool_scope: 'type_default',
      mode: 'async',
      description: 'Add tests for utils',
      prompt: 'Write node:test unit tests for every exported function in src/util.js and run them.',
    },
    // 强制只读子 Agent（禁止修改受保护资源）
    {
      agent_name: 'Reviewer',
      subagent_type: 'explore',
      tool_scope: 'type_default',
      readonly: true,
      description: 'Review recent changes',
      prompt: 'Review the diff in src/ and list correctness risks; do not modify anything.',
    },
    // 续跑已有线程：传 thread_id
    {
      agent_name: 'Scout',
      subagent_type: 'explore',
      tool_scope: 'type_default',
      thread_id: 'thr_abc123',
      description: 'Continue scan',
      prompt: 'Continue: now also check src/session and report token handling.',
    },
  ],
  notes: [
    '子 Agent 在独立上下文中运行；回传为 summary 文本 + 结构化 `<subagent-result>` 块（含 thread_id、status、artifacts）。',
    '跨作用域派发属于具体能力，由能力包注册专用工具并注入端口。',
    '失败或 wind_down 时同样返回结构化结果；主 Agent 可用 thread_id 续跑或自行接手。',
  ],
  schema: dispatchAgentSchema,
  permissions: [],
  isAvailable: (ctx) => !!ctx.dispatchSubAgent,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    if (!ctx.dispatchSubAgent) {
      throw new AppError('VALIDATION', '子 Agent 派发当前不可用。')
    }

    return ctx.dispatchSubAgent({
      agentName: input.agent_name,
      subagentType: input.subagent_type,
      toolScope: input.tool_scope,
      toolCategories: input.tool_categories,
      prompt: input.prompt,
      description: input.description,
      threadId: input.thread_id,
      mode: input.mode,
      // 方案模式下评审 Agent 只能读取和找问题，不能借子 Agent 绕过宿主的禁止实施边界。
      readonly: ctx.proposalMode ? true : input.readonly,
      model: input.model,
      effort: input.effort,
      routeCategory: input.route_category,
      attachments: input.attachments,
      interrupt: input.interrupt,
      // output_schema 存在时开放结构化输出契约（校验 + 修复闭环复用 Workflow 既有基建）。
      structuredOutputContract: input.output_schema ? { schema: input.output_schema } : undefined,
    })
  },
})

const dispatchAgentTools = {
  dispatch_agent: dispatchAgent,
}

export { dispatchAgentTools }
