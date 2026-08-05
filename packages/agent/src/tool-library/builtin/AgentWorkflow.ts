import { z } from 'zod'

import type {
  AgentWorkflowAgentCall,
  AgentWorkflowDefinition,
  AgentWorkflowStep,
} from '@velaros-ai/agent/protocol'
import {
  clampedInt,
  inferActionFromFields,
  withDefaultNote,
} from '@velaros-ai/agent/tool-contract'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'

const workflowPathSegmentSchema = z.union([
  z.string().trim().min(1).max(80),
  clampedInt(0, 1_000),
])
const workflowPathSchema = z.array(workflowPathSegmentSchema).max(8)
const workflowRootPathSchema = workflowPathSchema.default([])
const workflowOutputSchema = z.record(z.string().trim().min(1).max(120), z.unknown())
/**
 * 委派用的分类 id：本层只校形状，**不判允不允许委派**。
 *
 * 可委派性是具体产品策略，由注入的 capability delegation policy 在执行期判（`check:agent-schemas`
 * 防线②把这条写成了断言）。此前这里挂着一个恒空的黑名单 Set + 永远返回 true 的 refine——
 * 空壳门比没有门更坏：读者会以为委派边界在这一层把着。
 */
const workflowToolCategorySchema = z.string().trim().min(1).max(120)

const workflowAgentCallSchema: z.ZodType<AgentWorkflowAgentCall> = z.object({
  id: z.string().trim().min(1).max(80),
  agent_name: z.string().trim().min(2).max(40).regex(/^[A-Za-z][A-Za-z -]*$/).optional(),
  prompt: z.string().trim().min(20).max(12_000),
  description: z.string().trim().min(1).max(240).optional(),
  subagent_type: withDefaultNote(
    z.string().trim().min(1).max(64),
    'general',
    '缺省为 general。也可使用内置类型或已安装自定义 agent id。'
  ),
  tool_scope: withDefaultNote(
    z.enum(['type_default', 'inherit', 'custom']),
    'type_default',
    '缺省为 type_default。'
  ),
  tool_categories: z.array(workflowToolCategorySchema).max(8).default([]),
  readonly: withDefaultNote(z.boolean(), true, '缺省为 true；只有确需写入的节点才设为 false。'),
  model: z.string().trim().min(1).max(256).optional(),
  route_category: z.string().trim().min(1).max(80).optional(),
  attachments: z.array(z.string().trim().min(1).max(4_096)).max(12).default([]),
  output_schema: workflowOutputSchema.describe(
    parameterDescription({
      description:
        '强制结构化返回的有界 JSON Schema。必须是 object；不支持 $ref、组合 schema、pattern 或可执行扩展。',
    })
  ),
}).strip().superRefine((value, issueCtx) => {
  if (value.tool_scope !== 'custom' || !isEmpty(value.tool_categories)) return
  issueCtx.addIssue({
    code: 'custom',
    message: 'tool_scope=custom 时至少需要一个 tool_categories。',
    path: ['tool_categories'],
  })
})

const workflowSourceSchema = z.object({
  step_id: z.string().trim().min(1).max(80),
  path: workflowRootPathSchema,
}).strip()

const workflowPredicateSchema = z.object({
  path: workflowRootPathSchema,
  op: z.enum(['eq', 'neq', 'in', 'exists', 'gte', 'lte']),
  value: z.unknown().optional(),
}).strip()

const workflowConvergenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('no_new_items'),
    items_path: workflowRootPathSchema,
    key_path: workflowPathSchema,
    patience: withDefaultNote(clampedInt(1, 3), 1, '缺省 1，钳制到 1-3。'),
  }).strip(),
  z.object({
    kind: z.literal('count_at_least'),
    path: workflowRootPathSchema,
    count: clampedInt(1, 1_000),
  }).strip(),
  z.object({
    kind: z.literal('predicate'),
    predicate: workflowPredicateSchema,
  }).strip(),
])

const parallelStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  operation: z.literal('parallel'),
  calls: z.array(workflowAgentCallSchema).min(1).max(8),
  failure_policy: withDefaultNote(
    z.enum(['collect', 'fail_fast']),
    'collect',
    '缺省 collect；保留每个失败项并等待其它已启动项。'
  ),
}).strip()

const pipelineStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  operation: z.literal('pipeline'),
  items: z.array(z.unknown()).min(1).max(8),
  stages: z.array(workflowAgentCallSchema).min(1).max(8),
  failure_policy: withDefaultNote(
    z.enum(['collect', 'fail_fast']),
    'collect',
    '缺省 collect；单 item 失败不阻塞其它流水线。'
  ),
}).strip()

const repeatStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  operation: z.literal('repeat'),
  seed: z.unknown(),
  call: workflowAgentCallSchema,
  max_rounds: withDefaultNote(clampedInt(1, 6), 3, '缺省 3，钳制到 1-6。'),
  convergence: workflowConvergenceSchema,
}).strip()

const filterStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  operation: z.literal('filter'),
  source: workflowSourceSchema,
  predicate: workflowPredicateSchema,
}).strip()

const dedupeStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  operation: z.literal('dedupe'),
  source: workflowSourceSchema,
  key_paths: z.array(workflowPathSchema).min(1).max(4),
  keep: withDefaultNote(
    z.enum(['first', 'highest_confidence']),
    'first',
    '缺省保留第一个；highest_confidence 还应提供 confidence_path。'
  ),
  confidence_path: workflowPathSchema.optional(),
}).strip()

const majorityVoteStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  operation: z.literal('majority_vote'),
  source: workflowSourceSchema,
  vote_path: workflowPathSchema,
  group_path: workflowPathSchema.optional(),
  quorum: withDefaultNote(clampedInt(1, 8), 2, '缺省 2，钳制到 1-8。'),
  majority_threshold: withDefaultNote(
    z.number().transform((value) => Math.min(1, Math.max(0.5, value))),
    0.5,
    '缺省 0.5，钳制到 0.5-1。平票始终 inconclusive。'
  ),
}).strip()

const stepParsers = {
  parallel: parallelStepSchema,
  pipeline: pipelineStepSchema,
  repeat: repeatStepSchema,
  filter: filterStepSchema,
  dedupe: dedupeStepSchema,
  majority_vote: majorityVoteStepSchema,
} as const

const rawWorkflowStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  operation: z.enum(['parallel', 'pipeline', 'repeat', 'filter', 'dedupe', 'majority_vote']).optional(),
  calls: z.array(workflowAgentCallSchema).min(1).max(8).optional(),
  items: z.array(z.unknown()).min(1).max(8).optional(),
  stages: z.array(workflowAgentCallSchema).min(1).max(8).optional(),
  failure_policy: z.enum(['collect', 'fail_fast']).optional(),
  seed: z.unknown().optional(),
  call: workflowAgentCallSchema.optional(),
  max_rounds: clampedInt(1, 6).optional(),
  convergence: workflowConvergenceSchema.optional(),
  source: workflowSourceSchema.optional(),
  predicate: workflowPredicateSchema.optional(),
  key_paths: z.array(workflowPathSchema).min(1).max(4).optional(),
  keep: z.enum(['first', 'highest_confidence']).optional(),
  confidence_path: workflowPathSchema.optional(),
  vote_path: workflowPathSchema.optional(),
  group_path: workflowPathSchema.optional(),
  quorum: clampedInt(1, 8).optional(),
  majority_threshold: z.number().optional(),
}).strip()

const workflowStepSchema: z.ZodType<AgentWorkflowStep> = rawWorkflowStepSchema.transform((value, ctx) => {
  const operation = value.operation ?? inferActionFromFields(value, {
    parallel: ['calls'],
    pipeline: ['items', 'stages'],
    repeat: ['seed', 'call', 'convergence'],
    filter: ['predicate'],
    dedupe: ['key_paths'],
    majority_vote: ['vote_path', 'group_path', 'quorum'],
  })
  if (!operation || !(operation in stepParsers)) {
    ctx.addIssue({
      code: 'custom',
      message: '缺少或无法唯一推断 operation；可用 parallel、pipeline、repeat、filter、dedupe、majority_vote。',
      path: ['operation'],
    })
    return z.NEVER
  }
  const parsed = stepParsers[operation as keyof typeof stepParsers].safeParse({ ...value, operation })
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
  }
  return z.NEVER
})

const agentWorkflowSchema: z.ZodType<AgentWorkflowDefinition> = z.object({
  name: withDefaultNote(
    z.string().trim().min(1).max(120),
    'Multi-agent workflow',
    '缺省为 Multi-agent workflow。'
  ),
  // 这两条**不给 schema 默认值**。真实上限是 SubAgentDispatcher 的属性（并发信号量上限由宿主
  // 配置 `maxConcurrentSubAgents` 决定，总量帽是该执行剩余的派发额度），在 schema 里再钉一个
  // 常量就又造出第二本账：宿主把并发调到 8，模型不写这个字段却被 schema 默认值按死在 4。
  // 因此这里只保证"是个正整数"，钳制交给解释器按运行时真值做，生效值经 effective_limits 回显。
  max_concurrency: clampedInt(1, 64)
    .optional()
    .describe('可选。省略取派发器实际并发上限，生效值见 effective_limits。'),
  max_agents: clampedInt(1, 8)
    .optional()
    .describe('可选。省略取执行剩余派发额度（上限 8），与 dispatch 共用 32 帽。'),
  steps: z.array(workflowStepSchema).min(1).max(12),
}).strip()

type RunAgentWorkflowInput = AgentWorkflowDefinition

export {
  agentWorkflowSchema,
  type RunAgentWorkflowInput,
  workflowAgentCallSchema,
  workflowStepSchema,
}
