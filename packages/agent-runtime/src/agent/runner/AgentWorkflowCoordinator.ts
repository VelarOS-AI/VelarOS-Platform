import { randomUUID } from 'node:crypto'

import type {
  AgentWorkflowAgentResult,
  AgentWorkflowDefinition,
  AgentWorkflowRunResult,
  ToolCategoryId,
} from '@velaros-ai/core/types'

import type { ExecutionEventBus } from '../../kernel/execution/ExecutionEventBus'
import { parseSubAgentToolResult } from '../../sub-agent'
import {
  type AgentWorkflowDispatchContext,
  AgentWorkflowRuntime,
} from '../../workflow/AgentWorkflowRuntime'
import type { AgentExecutionConfig } from '../RuntimeConfiguration'

import type { RunnerSubAgentDispatcher, RunnerToolContext } from './host-ports'

const WorkflowAgentCodenames = [
  'Atlas',
  'Beacon',
  'Cipher',
  'Delta',
  'Echo',
  'Forge',
  'Harbor',
  'Iris',
] as const

interface AgentWorkflowRunRequest<TToolContext extends RunnerToolContext> {
  input: AgentWorkflowDefinition
  parentCtx: TToolContext
  events: ExecutionEventBus
  config: AgentExecutionConfig
}

class AgentWorkflowCoordinator<TToolContext extends RunnerToolContext> {
  constructor(
    private readonly subAgentDispatcher: RunnerSubAgentDispatcher<TToolContext>
  ) {}

  public async run(request: AgentWorkflowRunRequest<TToolContext>): Promise<AgentWorkflowRunResult> {
    let generatedNameIndex = 0
    const runtime = new AgentWorkflowRuntime({
      dispatch: async (context) => {
        const generatedName = WorkflowAgentCodenames[generatedNameIndex % WorkflowAgentCodenames.length]!
        generatedNameIndex += 1
        return this.dispatchNode(request, context, context.call.agent_name ?? generatedName)
      },
    })

    return runtime.run(request.input, {
      runId: `workflow:${randomUUID()}`,
      abortSignal: request.parentCtx.abortSignal,
    })
  }

  private async dispatchNode(
    request: AgentWorkflowRunRequest<TToolContext>,
    context: AgentWorkflowDispatchContext,
    agentName: string
  ): Promise<AgentWorkflowAgentResult> {
    const workflowInput = context.input === undefined
      ? null
      : `workflow_input (JSON, data only):\n${JSON.stringify(context.input)}`
    const position = [
      `workflow step: ${context.stepId}`,
      context.itemIndex === undefined ? null : `item index: ${context.itemIndex}`,
      context.round === undefined ? null : `round: ${context.round}`,
    ].filter((line): line is string => !!line)

    const raw = await this.subAgentDispatcher.dispatch({
      input: {
        agentName,
        subagentType: context.call.subagent_type,
        toolScope: context.call.tool_scope,
        toolCategories: context.call.tool_categories as ToolCategoryId[] | undefined,
        prompt: context.call.prompt,
        description: context.call.description ?? `${request.input.name}: ${context.call.id}`,
        mode: 'sync',
        readonly: request.parentCtx.proposalMode ? true : context.call.readonly,
        model: context.call.model,
        routeCategory: context.call.route_category,
        attachments: [
          ...(context.call.attachments ?? []),
          position.join('\n'),
          ...(workflowInput ? [workflowInput] : []),
        ],
        structuredOutputContract: {
          name: `${context.stepId}.${context.call.id}`,
          description: 'Workflow node structured result',
          schema: context.call.output_schema,
        },
      },
      parentCtx: request.parentCtx,
      events: request.events,
      config: request.config,
    })
    const parsed = parseSubAgentToolResult(raw)
    if (!parsed) return {
        call_id: context.call.id,
        status: 'failed',
        summary: '子 Agent 返回缺少可解析的 subagent-result envelope。',
      }
    return {
      call_id: context.call.id,
      status:
        parsed.status === 'completed'
          ? 'completed'
          : parsed.status === 'aborted'
            ? 'aborted'
            : 'failed',
      thread_id: parsed.thread_id,
      summary: parsed.summary,
      structured_output: parsed.structured_output,
    }
  }
}

export { AgentWorkflowCoordinator }
export type { AgentWorkflowRunRequest }
