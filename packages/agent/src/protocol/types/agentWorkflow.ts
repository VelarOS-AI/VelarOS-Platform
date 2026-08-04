/** JSON Schema 子集。运行时会在编译前执行深度、字段数、关键字和字节上限检查。 */
export type AgentOutputJsonSchema = Record<string, unknown>

export type AgentWorkflowValuePath = Array<string | number>

export type AgentWorkflowFailurePolicy = 'collect' | 'fail_fast'
export type AgentWorkflowPredicateOperator = 'eq' | 'neq' | 'in' | 'exists' | 'gte' | 'lte'
export type AgentWorkflowRunStatus = 'completed' | 'partial' | 'failed' | 'budget_exhausted' | 'aborted'
export type AgentWorkflowAgentStatus = 'completed' | 'failed' | 'aborted' | 'skipped'

export interface AgentWorkflowValueRef {
  step_id: string
  path?: AgentWorkflowValuePath
}

export interface AgentWorkflowPredicate {
  path: AgentWorkflowValuePath
  op: AgentWorkflowPredicateOperator
  value?: unknown
}

export interface AgentWorkflowAgentCall {
  id: string
  agent_name?: string
  prompt: string
  description?: string
  subagent_type?: string
  tool_scope?: 'type_default' | 'inherit' | 'custom'
  tool_categories?: string[]
  readonly?: boolean
  model?: string
  route_category?: string
  attachments?: string[]
  output_schema: AgentOutputJsonSchema
}

export interface AgentWorkflowParallelStep {
  id: string
  operation: 'parallel'
  calls: AgentWorkflowAgentCall[]
  failure_policy?: AgentWorkflowFailurePolicy
}

export interface AgentWorkflowPipelineStep {
  id: string
  operation: 'pipeline'
  items: unknown[]
  stages: AgentWorkflowAgentCall[]
  failure_policy?: AgentWorkflowFailurePolicy
}

export type AgentWorkflowRepeatConvergence =
  | {
      kind: 'no_new_items'
      items_path?: AgentWorkflowValuePath
      key_path: AgentWorkflowValuePath
      patience?: number
    }
  | {
      kind: 'count_at_least'
      path?: AgentWorkflowValuePath
      count: number
    }
  | {
      kind: 'predicate'
      predicate: AgentWorkflowPredicate
    }

export interface AgentWorkflowRepeatStep {
  id: string
  operation: 'repeat'
  seed: unknown
  call: AgentWorkflowAgentCall
  max_rounds?: number
  convergence: AgentWorkflowRepeatConvergence
}

export interface AgentWorkflowFilterStep {
  id: string
  operation: 'filter'
  source: AgentWorkflowValueRef
  predicate: AgentWorkflowPredicate
}

export interface AgentWorkflowDedupeStep {
  id: string
  operation: 'dedupe'
  source: AgentWorkflowValueRef
  key_paths: AgentWorkflowValuePath[]
  keep?: 'first' | 'highest_confidence'
  confidence_path?: AgentWorkflowValuePath
}

export interface AgentWorkflowMajorityVoteStep {
  id: string
  operation: 'majority_vote'
  source: AgentWorkflowValueRef
  vote_path: AgentWorkflowValuePath
  group_path?: AgentWorkflowValuePath
  quorum?: number
  majority_threshold?: number
}

export type AgentWorkflowStep =
  | AgentWorkflowParallelStep
  | AgentWorkflowPipelineStep
  | AgentWorkflowRepeatStep
  | AgentWorkflowFilterStep
  | AgentWorkflowDedupeStep
  | AgentWorkflowMajorityVoteStep

export interface AgentWorkflowDefinition {
  name: string
  max_concurrency?: number
  max_agents?: number
  steps: AgentWorkflowStep[]
}

export interface AgentWorkflowAgentResult {
  call_id: string
  status: AgentWorkflowAgentStatus
  thread_id?: string
  summary: string
  structured_output?: unknown
}

export interface AgentWorkflowStepResult {
  id: string
  operation: AgentWorkflowStep['operation']
  status: 'completed' | 'partial' | 'failed' | 'budget_exhausted' | 'aborted'
  output: unknown
  agent_count: number
  error?: string
}

export interface AgentWorkflowRunResult {
  workflow_run_id: string
  name: string
  status: AgentWorkflowRunStatus
  effective_limits: {
    max_concurrency: number
    max_agents: number
  }
  agent_count: number
  steps: AgentWorkflowStepResult[]
  output: unknown
}

export interface SubAgentStructuredOutputContract {
  schema: AgentOutputJsonSchema
  name?: string
  description?: string
}
