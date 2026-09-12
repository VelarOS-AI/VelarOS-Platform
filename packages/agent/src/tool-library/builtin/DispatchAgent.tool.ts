import { AppError } from '@velaros-ai/core/error'

import { defineVelaTool } from '../defineVelaTool'

import { AgentDispatchCapability } from './Capabilities'
import type { DispatchAgentInput } from './DispatchAgent'
import { dispatchAgentSchema } from './DispatchAgent'

const dispatchAgent = defineVelaTool<DispatchAgentInput>({
  name: 'agent:dispatch',
  role: 'control',
  category: 'agent-control',
  summary: '在当前执行作用域中派发独立 sub-agent。',
  suitable: [
    '仅复杂任务：并行探索多目录/方案，或单条子任务本身就需很多步。',
    '并行处理可独立完成、无需实时共享中间状态的子任务。',
  ],
  forbidden: [
    '默认不派：简单/单步任务（读文件、跑命令）自己直接做，更快。',
    '工具调不出时用 tooling:map/tooling:replace 换入自用，别拿子 Agent 绕过。',
    '不派彼此实时同步的串行任务；子 Agent 不能再派子 Agent。',
    '不要用子 Agent 绕过宿主的能力、权限或作用域边界。',
  ],
  usage: [
    '新派时 prompt 必须自洽：子 Agent 看不到你的会话历史，目标/已知事实/范围边界/成功标准/输出长度都要写进去；续跑只写追加的任务。',
    '同一轮可多次调用 agent:dispatch 实现并行；系统会自动限制并发数。',
    'mode=sync（默认）阻塞到完成并内联返回结果——不要再调 job:wait，也不要因为没立刻拿到就重派；mode=async 立即返回可等待 job，之后用 job:read_output/job:wait 收束。',
    'subagent_type 来自运行时公开的类型表；tool_scope 用 type_default、inherit 或 custom（custom 时填 tool_categories）。',
    '优先复用：同一工作线上的追问、补做、纠偏、修复后复验，用 thread_id 续跑已派的子 Agent（它保留着读过的上下文，不必重读）；复验就续跑原验证者。',
    '需要独立上下文才新派：独立复核/第二意见（不让产出者复核自己的产出）、原线程跑偏或上下文过大、换了作用域或无关新任务。',
    '请人复核时必给 readonly=true；需要机器可读结果时给 output_schema，结果落在 structured_output。',
    'agent_name 必须是英文代号名，不要带数字，例如 Atlas、Forge、Scout、Beacon。',
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
    // 异步后台任务：mode:async，父 Agent 先继续，之后用 job:wait/job:read_output 收束
    {
      agent_name: 'Builder',
      subagent_type: 'general',
      tool_scope: 'type_default',
      mode: 'async',
      description: 'Add tests for utils',
      prompt: 'Write node:test unit tests for every exported function in src/util.js and run them.',
    },
    // 修复后复验：续跑原来的验证者，它还记得失败现场
    {
      thread_id: 'subagent:verifier-thread',
      prompt: 'Fixed the null check in src/auth/login.ts; re-run the auth tests.',
    },
    { thread_id: 'subagent:running-thread', interrupt: true },
  ],
  notes: [
    '子 Agent 在独立上下文中运行；回传为 summary 文本 + 结构化 `<subagent-result>` 块（含 thread_id、status、resumable、artifacts）。',
    '失败、中断或 wind_down 也返回结构化结果；resumable=true 可带 thread_id 续跑，否则新派或自行接手。线程只保留有限时间，过期续跑会明确报错。',
    '跨作用域派发属于具体能力，由能力包注册专用工具并注入端口。',
  ],
  usageSkillId: 'sub-agent-orchestration',
  schema: dispatchAgentSchema,
  permissions: [],
  capabilities: AgentDispatchCapability,
  isAvailable: (ctx) => !!ctx.dispatchSubAgent,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    if (!ctx.dispatchSubAgent) {
      throw new AppError('VALIDATION', '子 Agent 派发当前不可用。')
    }

    // snake_case 的模型面参数只有这 7 个需要改名成宿主面 camelCase；其余同名字段整块 spread，
    // 免得逐字段抄一遍（抄写既冗长又会在 schema 加字段时静默漏传）。
    const {
      agent_name: agentName,
      subagent_type: subagentType,
      tool_scope: toolScope,
      tool_categories: toolCategories,
      thread_id: threadId,
      route_category: routeCategory,
      output_schema: outputSchema,
      prompt,
      ...sameNameFields
    } = input

    // schema 只为新建调用补默认，续跑保留 undefined 交给 dispatcher 从已有 session 继承。
    // 这里的回退也保护绕过 schema 直接调用 execute 的内部宿主；中断在 dispatcher 入口最先处理，
    // prompt 占位不会进入执行链。
    const creatingThread = !threadId

    return ctx.dispatchSubAgent({
      ...sameNameFields,
      prompt: prompt ?? '',
      agentName,
      subagentType: subagentType ?? (creatingThread ? 'general' : undefined),
      toolScope: toolScope ?? (creatingThread ? 'type_default' : undefined),
      toolCategories: toolCategories ?? (creatingThread ? [] : undefined),
      threadId,
      routeCategory,
      // output_schema 存在时开放结构化输出契约（校验 + 修复闭环复用 Workflow 既有基建）。
      structuredOutputContract: outputSchema ? { schema: outputSchema } : undefined,
    })
  },
})

const dispatchAgentTools = {
  'agent:dispatch': dispatchAgent,
}

export { dispatchAgentTools }
