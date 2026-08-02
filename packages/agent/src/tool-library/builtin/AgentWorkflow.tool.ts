import { AppError } from '@velaros-ai/core/error'

import { defineVelaTool, type VelaTool } from '../defineVelaTool'

import { agentWorkflowSchema, type RunAgentWorkflowInput } from './AgentWorkflow'

interface AgentWorkflowToolCollection {
  readonly 'agent:run_workflow': VelaTool<RunAgentWorkflowInput>
}

const runAgentWorkflow: VelaTool<RunAgentWorkflowInput> = defineVelaTool({
  name: 'agent:run_workflow',
  role: 'control',
  category: 'general',
  summary: '用声明式、有界控制流编排多个一级子 Agent，并在代码侧收敛结构化结果。',
  suitable: [
    '复杂任务需要固定 fan-out、无栅栏流水线、有界多轮收敛或多数票时。',
    '需要多个独立 reviewer 先按 JSON Schema 返回，再由代码侧 filter/dedupe/投票时。',
  ],
  forbidden: [
    '简单或单步任务不要建 Workflow；直接做或派一个子 Agent 更快。',
    '不得把 operation 当通用脚本；没有 fs、网络、process、require/import 或任意代码执行能力。',
    '是否可调用由产品委派策略决定；Workflow 不能派孙 Agent。',
    '不要用 Workflow 绕过 Project 权限、proposal mode、工具分类或写租约。',
  ],
  usage: [
    'steps 按数组顺序执行；reducer 的 source.step_id 只能引用更早的 step。',
    'parallel 是栅栏；pipeline 让每个 item 独立穿过 stages，不为不同 item 建 stage 间栅栏。',
    'repeat 必须给 convergence，最多 6 轮；整次 Workflow 最多 8 个 Agent，并发最多 4，仍共享 execution 级 32 派发帽。',
    '每个 Agent call 必须提供 output_schema；最终只接受符合 schema 的 JSON，修复失败会作为该节点失败。',
    'parallel 的输出项包含 structured_output；多数票通常用 vote_path=["structured_output","verdict"]。',
    '多数票缺 quorum、平票或未达 threshold 时返回 inconclusive，不会默认判通过。',
    '动态 pipeline/repeat input 由宿主作为 workflow_input JSON 附件传入，不使用字符串模板。',
  ],
  examples: [
    {
      name: 'Independent review vote',
      max_concurrency: 3,
      max_agents: 3,
      steps: [
        {
          id: 'reviews',
          operation: 'parallel',
          calls: ['Atlas', 'Beacon', 'Cipher'].map((agent_name, index) => ({
            id: `review-${index + 1}`,
            agent_name,
            subagent_type: 'review',
            prompt: 'Independently inspect the current project change. Return a verdict and concise reason; do not modify files.',
            readonly: true,
            output_schema: {
              type: 'object',
              properties: {
                verdict: { type: 'string', enum: ['approve', 'reject'] },
                reason: { type: 'string', maxLength: 500 },
              },
              required: ['verdict', 'reason'],
              additionalProperties: false,
            },
          })),
        },
        {
          id: 'decision',
          operation: 'majority_vote',
          source: { step_id: 'reviews' },
          vote_path: ['structured_output', 'verdict'],
          quorum: 2,
        },
      ],
    },
  ],
  notes: [
    '结果回显 effective_limits、agent_count、每步状态和最终 output；钳制后的真实上限以 effective_limits 为准。',
    '所有节点都经 SubAgentDispatcher，因此保留并发信号量、派发计数、进展熔断、沙箱、取消、模型路由和 UI worker 事件。',
  ],
  schema: agentWorkflowSchema,
  permissions: [],
  isAvailable: (ctx) => !!ctx.runAgentWorkflow,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    if (!ctx.runAgentWorkflow) {
      throw new AppError('VALIDATION', '多 Agent Workflow 当前不可用。')
    }
    return ctx.runAgentWorkflow(input)
  },
})

const agentWorkflowTools: AgentWorkflowToolCollection = {
  'agent:run_workflow': runAgentWorkflow,
}

export { agentWorkflowTools }
export type { AgentWorkflowToolCollection }
