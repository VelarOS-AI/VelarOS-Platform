import { isPlainObject, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import type { ToolAvailabilityScope } from '@velaros-ai/core/types'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import {
  isControlToolName,
  parseTimedToolCallInput,
  ReflectToolCallToolName,
} from './ControlToolInput'
import type {
  ToolExecutionPolicyContext,
  ToolExecutionPrepared,
  ToolFailureResult,
} from './ExecutionPolicy'
import { type ToolExecutionPolicy } from './ExecutionPolicy'
import type { PendingTool, ToolExecutorEvents, ToolResult } from './Executor'
import { emitToolMetadataEvent, emitToolProgressEvent } from './Executor'
import { buildToolSpaceRecoveryGuide, type ToolSpaceRecoveryGuide } from './tool-space-recovery'

const log = logRuntime.tag('ControlToolRunner')

type TimedToolCallExecutionResult =
  | { status: 'completed'; result: ToolResult; elapsedMs: number }
  | { status: 'timeout'; result: ToolResult; elapsedMs: number }

type NestedToolCallResult =
  | { status: 'blocked'; result: ToolResult }
  | { status: 'completed'; result: ToolResult; elapsedMs: number }
  | { status: 'failed'; result: ToolResult; elapsedMs: number }
  | { status: 'timeout'; result: ToolResult; elapsedMs: number }

interface ActiveToolFailureInput {
  toolName: string
  args: Record<string, unknown>
  isConcurrencySafe: boolean
  toolContext?: LooseOptional<ToolExecutionPolicyContext>
  error: AppError
}

interface ControlToolRunnerOptions {
  ctx: ToolExecutionPolicyContext
  events: ToolExecutorEvents
  executionPolicy: ToolExecutionPolicy
  executePreparedTool: (
    tool: PendingTool,
    prepared: ToolExecutionPrepared,
    args: Record<string, unknown> | undefined,
    toolName: string
  ) => Promise<ToolResult>
  finalizeResult: (tool: PendingTool, result: ToolResult) => Promise<ToolResult>
  buildExecutionAppError: (
    error: unknown,
    toolContext?: LooseOptional<ToolExecutionPolicyContext>
  ) => AppError
  applyExecutionFailureSideEffects: (input: ActiveToolFailureInput) => LooseOptional<AppError>
  readTerminalError: () => LooseOptional<AppError>
}

class ControlToolRunner {
  private readonly ctx: ToolExecutionPolicyContext
  private readonly events: ToolExecutorEvents
  private readonly executionPolicy: ToolExecutionPolicy
  private readonly executePreparedTool: ControlToolRunnerOptions['executePreparedTool']
  private readonly finalizeResult: ControlToolRunnerOptions['finalizeResult']
  private readonly buildExecutionAppError: ControlToolRunnerOptions['buildExecutionAppError']
  private readonly applyExecutionFailureSideEffects: ControlToolRunnerOptions['applyExecutionFailureSideEffects']
  private readonly readTerminalError: ControlToolRunnerOptions['readTerminalError']

  constructor(options: ControlToolRunnerOptions) {
    this.ctx = options.ctx
    this.events = options.events
    this.executionPolicy = options.executionPolicy
    this.executePreparedTool = options.executePreparedTool
    this.finalizeResult = options.finalizeResult
    this.buildExecutionAppError = options.buildExecutionAppError
    this.applyExecutionFailureSideEffects = options.applyExecutionFailureSideEffects
    this.readTerminalError = options.readTerminalError
  }

  public run(wrapperTool: PendingTool, toolAbort: AbortController): Promise<ToolResult> {
    if (wrapperTool.toolName === ReflectToolCallToolName)
      return this.runReflectToolCall(wrapperTool, toolAbort)

    return Promise.resolve(
      this.buildControlToolFailure(wrapperTool, {
        error: 'tool_call_invalid',
        reason: `Unsupported control tool: ${wrapperTool.toolName}`,
        targetToolName: wrapperTool.toolName,
      })
    )
  }


  private async runReflectToolCall(
    wrapperTool: PendingTool,
    toolAbort: AbortController
  ): Promise<ToolResult> {
    if (!this.isToolVisible(wrapperTool.toolName)) {
      const unavailable = `Tool is not available in the current model turn: ${wrapperTool.toolName}`
      const recovery = buildToolSpaceRecoveryGuide({ toolName: wrapperTool.toolName })
      return this.buildControlToolFailure(wrapperTool, {
        error: 'tool_unavailable',
        reason: unavailable,
        targetToolName: wrapperTool.toolName,
        recovery,
      })
    }

    const wrapperDecision = this.executionPolicy.prepareExecution({
      toolCallId: wrapperTool.toolCallId,
      toolName: wrapperTool.toolName,
      args: wrapperTool.args,
      baseContext: this.ctx,
      abortSignal: toolAbort.signal,
      emitProgress: (chunk) => this.emitToolProgress(wrapperTool.toolCallId, chunk),
      updateMetadata: (payload) => this.emitToolMetadata(wrapperTool.toolCallId, payload),
    })
    if (!wrapperDecision.allowed)
      return {
        toolCallId: wrapperTool.toolCallId,
        toolName: wrapperTool.toolName,
        error: wrapperDecision.error,
        result: this.executionPolicy.buildBlockedFailureResult(
          wrapperTool.toolName,
          wrapperDecision.error,
          this.ctx
        ),
      }

    const parsed = parseTimedToolCallInput(wrapperTool.args)
    if (!parsed.ok)
      return this.buildControlToolFailure(wrapperTool, {
        error: 'tool_call_invalid',
        reason: parsed.reason,
        targetToolName: ReflectToolCallToolName,
      })

    const { toolName, args, timeoutMs, reason } = parsed.input
    if (this.isForbiddenNestedTarget(toolName))
      return this.buildControlToolFailure(wrapperTool, {
        error: 'tool_call_invalid',
        reason: `Reflection proxy cannot call a control tool: ${toolName}.`,
        targetToolName: toolName,
        timeoutMs,
      })

    const startedAt = Date.now()
    const nestedExecution = await this.executeNestedToolCall({
      wrapperTool,
      toolName,
      args,
      timeoutMs,
      toolAbort,
      availabilityScope: this.isToolVisible(toolName) ? 'enabled' : 'all',
    })
    if (nestedExecution.status === 'blocked') {
      const nestedResult = nestedExecution.result.result
      return {
        toolCallId: wrapperTool.toolCallId,
        toolName: wrapperTool.toolName,
        error: nestedExecution.result.error,
        result: {
          ...(isPlainObject(nestedResult) ? nestedResult : { result: nestedResult }),
          toolName,
          wrapperToolName: wrapperTool.toolName,
          reflected: true,
          timeoutMs,
        },
      }
    }

    if (nestedExecution.status === 'timeout') {
      const message = `Reflected tool "${toolName}" exceeded timeout (${timeoutMs}ms).`
      return {
        toolCallId: wrapperTool.toolCallId,
        toolName: wrapperTool.toolName,
        error: message,
        result: {
          error: 'tool_timeout',
          reason: message,
          toolName,
          wrapperToolName: wrapperTool.toolName,
          reflected: true,
          timeoutMs,
          elapsedMs: nestedExecution.elapsedMs,
          requestedReason: toNullable(reason),
        },
      }
    }

    if (nestedExecution.status === 'failed') {
      const nestedResult = nestedExecution.result.result
      return {
        toolCallId: wrapperTool.toolCallId,
        toolName: wrapperTool.toolName,
        error: nestedExecution.result.error,
        result: {
          ...(isPlainObject(nestedResult) ? nestedResult : { result: nestedResult }),
          toolName,
          wrapperToolName: wrapperTool.toolName,
          reflected: true,
          timeoutMs,
          elapsedMs: nestedExecution.elapsedMs,
          requestedReason: toNullable(reason),
        },
      }
    }

    return {
      toolCallId: wrapperTool.toolCallId,
      toolName: wrapperTool.toolName,
      result: {
        ok: true,
        toolName,
        wrapperToolName: wrapperTool.toolName,
        reflected: true,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
        requestedReason: toNullable(reason),
        result: nestedExecution.result.result,
      },
    }
  }

  private async executeNestedToolCall(input: {
    wrapperTool: PendingTool
    nestedToolCallId?: string
    toolName: string
    args: Record<string, unknown>
    timeoutMs: number
    toolAbort: AbortController
    availabilityScope?: ToolAvailabilityScope
  }): Promise<NestedToolCallResult> {
    const toolName = this.executionPolicy.resolveCanonicalToolName(input.toolName)
    const nestedTool: PendingTool = {
      toolCallId: input.nestedToolCallId ?? `${input.wrapperTool.toolCallId}:nested`,
      toolName,
      args: input.args,
      isConcurrencySafe: this.executionPolicy.resolveConcurrencySafe(toolName, input.args),
      status: 'executing',
    }
    const decision = this.executionPolicy.prepareExecution({
      toolCallId: nestedTool.toolCallId,
      toolName: nestedTool.toolName,
      args: nestedTool.args,
      baseContext: this.ctx,
      abortSignal: input.toolAbort.signal,
      emitProgress: (chunk) => this.emitToolProgress(nestedTool.toolCallId, chunk),
      updateMetadata: (payload) => this.emitToolMetadata(nestedTool.toolCallId, payload),
      availabilityScope: input.availabilityScope,
    })
    this.events.emitToolStart({
      toolCallId: nestedTool.toolCallId,
      toolName: nestedTool.toolName,
      args: nestedTool.args,
      categoryId: this.executionPolicy.getToolCategoryId(nestedTool.toolName) || undefined,
    })
    if (!decision.allowed) {
      const blocked = await this.finalizeResult(nestedTool, {
        toolCallId: nestedTool.toolCallId,
        toolName: nestedTool.toolName,
        error: decision.error,
        result: this.executionPolicy.buildBlockedFailureResult(
          nestedTool.toolName,
          decision.error,
          this.ctx
        ),
      })
      return {
        status: 'blocked',
        result: blocked,
      }
    }
    const startedAt = Date.now()
    let execution: TimedToolCallExecutionResult
    try {
      execution = await this.executePreparedToolWithTimeout(
        nestedTool,
        decision.prepared,
        input.timeoutMs,
        input.toolAbort
      )
    } catch (err) {
      const appError = this.buildExecutionAppError(err, decision.prepared.toolContext)
      this.applyExecutionFailureSideEffects({
        toolName: nestedTool.toolName,
        args: nestedTool.args,
        isConcurrencySafe: nestedTool.isConcurrencySafe,
        toolContext: decision.prepared.toolContext,
        error: appError,
      })
      const failed = await this.finalizeResult(nestedTool, {
        toolCallId: nestedTool.toolCallId,
        toolName: nestedTool.toolName,
        error: appError.message,
        result: this.executionPolicy.buildExecutionFailureResult(nestedTool.toolName, appError),
      })
      return {
        status: 'failed',
        result: failed,
        elapsedMs: Date.now() - startedAt,
      }
    }
    if (execution.status === 'timeout') return execution

    return {
      ...execution,
      result: await this.finalizeResult(nestedTool, execution.result),
    }
  }

  private isForbiddenNestedTarget(toolName: string): boolean {
    return isControlToolName(toolName) || this.executionPolicy.getToolRole(toolName) === 'control'
  }

  private isToolVisible(toolName: string): boolean {
    const visibleToolNames = this.ctx.getCurrentVisibleToolNames?.()
    if (!visibleToolNames || visibleToolNames.length === 0) return true

    return visibleToolNames.includes(toolName)
  }

  private buildControlToolFailure(
    wrapperTool: PendingTool,
    input: {
      error: string
      reason: string
      targetToolName: string
      timeoutMs?: number
      recovery?: ToolSpaceRecoveryGuide
    }
  ): ToolResult {
    const recoveryFields = input.recovery
      ? {
          nextActions: input.recovery.nextActions,
          toolSpaceRecovery: input.recovery,
        }
      : {}

    return {
      toolCallId: wrapperTool.toolCallId,
      toolName: wrapperTool.toolName,
      error: input.reason,
      result: {
        error: input.error,
        reason: input.reason,
        toolName: input.targetToolName,
        wrapperToolName: wrapperTool.toolName,
        timeoutMs: toNullable(input.timeoutMs),
        timedOut: false,
        ...recoveryFields,
      },
    }
  }

  private async executePreparedToolWithTimeout(
    tool: PendingTool,
    prepared: ToolExecutionPrepared,
    timeoutMs: number,
    toolAbort: AbortController
  ): Promise<TimedToolCallExecutionResult> {
    const timers = new TimerScope({ name: 'ToolExecutor.nestedToolCallTimeout' })
    const startedAt = Date.now()
    const execution = this.executePreparedTool(tool, prepared, tool.args, tool.toolName)
    const timeout = new Promise<TimedToolCallExecutionResult>((resolve, reject) => {
      timers.after(
        timeoutMs,
        () => {
          void (async () => {
            const message = `Tool "${tool.toolName}" exceeded timeout (${timeoutMs}ms).`
            const result: ToolResult = {
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
              error: message,
              result: {
                error: 'tool_timeout',
                reason: message,
                toolName: tool.toolName,
                timeoutMs,
                elapsedMs: Date.now() - startedAt,
                timedOut: true,
              },
            }
            try {
              resolve({
                status: 'timeout',
                result: await this.finalizeResult(tool, result),
                elapsedMs: Date.now() - startedAt,
              })
            } catch (error) {
              reject(error)
            } finally {
              toolAbort.abort(`tool_timeout:${tool.toolName}:${timeoutMs}`)
            }
          })()
        },
        { unref: true }
      )
    })

    try {
      const result = await Promise.race([
        execution.then((toolResult) => ({
          status: 'completed' as const,
          result: toolResult,
          elapsedMs: Date.now() - startedAt,
        })),
        timeout,
      ])
      if (result.status === 'timeout') {
        execution.catch((error) => {
          const appError = AppError.from(error)
          log.warn('nested tool settled after timeout', {
            toolName: tool.toolName,
            code: appError.code,
          })
        })
      }
      return result
    } finally {
      timers.dispose()
    }
  }

  private emitToolProgress(toolCallId: string, chunk: string): void {
    emitToolProgressEvent(this.events, toolCallId, chunk)
  }

  private emitToolMetadata(
    toolCallId: string,
    payload: { title?: string; metadata?: Record<string, unknown> }
  ): void {
    emitToolMetadataEvent(this.events, toolCallId, payload)
  }

  private buildToolFailureResult(
    error: string,
    reason: string,
    toolName: string
  ): ToolFailureResult {
    return {
      error,
      reason,
      toolName,
    }
  }
}

export { ControlToolRunner }
export type { ActiveToolFailureInput, ControlToolRunnerOptions }
