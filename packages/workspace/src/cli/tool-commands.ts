import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isArray, isRecord, isString, isUndefined, optionalWhen, stringifyPretty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { createAgentTools } from '../agent-tools.js'
import type { Workspace } from '../core/workspace.js'
import { createWorkspaceToolSchemaBundle } from '../tool-schema.js'

import { WorkspaceCliError, type WorkspaceCliRequest, type WorkspaceCliWorkflowStep } from './types.js'

export interface RunWorkspaceToolCommandInput {
  request: WorkspaceCliRequest
  workspace: Workspace
  cwd: string
}

export interface WorkspaceToolCommandResult {
  kind: string
  result: any
  text: string
  exitCode?: number
}

interface WorkspaceToolWorkflowResult {
  id: string
  tool: string
  status: 'ok'
  durationMs: number
  result: any
}

export async function runWorkspaceToolCommand(
  input: RunWorkspaceToolCommandInput
): Promise<WorkspaceToolCommandResult> {
  const { request, workspace, cwd } = input
  const tools = createAgentTools(workspace)

  switch (request.command) {
    case 'tools.list':
      return toolCommandResult(request.command, createWorkspaceToolSchemaBundle(tools))
    case 'tools.call': {
      const toolName = optionalWhen(isString, request.args.toolName, '')
      const tool = tools.find((candidate) => candidate.name === toolName)
      if (!tool) {
        throw new WorkspaceCliError('UNKNOWN_TOOL', `Unknown workspace tool: ${toolName}`, 2, {
          toolName,
        })
      }

      const args = await readJsonPayload(cwd, {
        inlineJson: optionalWhen(isString, request.args.argsJson),
        filePath: optionalWhen(isString, request.args.argsFile),
        defaultValue: {},
      })
      if (!isRecord(args)) {
        throw new WorkspaceCliError('ARGUMENT_ERROR', 'Tool call args must be an object.', 2, {
          field: 'args',
        })
      }
      return toolCommandResult(request.command, await tool.execute(args))
    }
    case 'tools.workflow': {
      const steps = await readJsonPayload<WorkspaceCliWorkflowStep[]>(cwd, {
        inlineJson: optionalWhen(isString, request.args.stepsJson),
        filePath: optionalWhen(isString, request.args.stepsFile),
        defaultValue: [],
      })
      if (!isArray(steps)) {
        throw new WorkspaceCliError('ARGUMENT_ERROR', 'Workflow steps JSON must be an array.', 2)
      }

      const results: WorkspaceToolWorkflowResult[] = []
      for (const [index, step] of steps.entries()) {
        const validatedStep = validateWorkflowStep(step, index)
        const stepId = validatedStep.id ?? String(index + 1)
        const toolName = validatedStep.tool
        const tool = tools.find((candidate) => candidate.name === toolName)
        if (!tool) {
          throw new WorkspaceCliError('UNKNOWN_TOOL', `Unknown workspace tool: ${toolName}`, 2, {
            stepId,
            toolName,
          })
        }

        const startedAt = Date.now()
        const result = await tool.execute(validatedStep.args ?? {})
        results.push({
          id: stepId,
          tool: toolName,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          result,
        })
      }

      return toolCommandResult(request.command, { results })
    }
    default:
      throw new WorkspaceCliError('UNKNOWN_COMMAND', `Unknown command: ${request.command}`, 2, {
        command: request.command,
      })
  }
}

function validateWorkflowStep(
  step: any,
  stepIndex: number
): { id?: string; tool: string; args?: Record<string, any> } {
  if (!isRecord(step)) {
    throw new WorkspaceCliError('ARGUMENT_ERROR', 'Workflow step must be an object.', 2, {
      stepIndex,
    })
  }

  const tool = optionalWhen(isString, step.tool)?.trim()
  if (!tool) {
    throw new WorkspaceCliError('ARGUMENT_ERROR', 'Workflow step requires a tool.', 2, {
      stepIndex,
      field: 'tool',
    })
  }

  let args: Record<string, any> | undefined
  const stepRecord = step
  if (!isUndefined(stepRecord.args)) {
    if (!isRecord(stepRecord.args)) {
      throw new WorkspaceCliError('ARGUMENT_ERROR', 'Workflow step args must be an object.', 2, {
        stepIndex,
        field: 'args',
      })
    }
    args = stepRecord.args
  }

  return {
    id: optionalWhen(isString, step.id),
    tool,
    args,
  }
}

async function readJsonPayload<T>(
  cwd: string,
  input: { inlineJson?: LooseOptional<string>; filePath?: LooseOptional<string>; defaultValue: T }
): Promise<T> {
  const hasInlineJson = isString(input.inlineJson)
  const hasFilePath = isString(input.filePath)

  if (hasInlineJson && hasFilePath) {
    throw new WorkspaceCliError('ARGUMENT_ERROR', 'Use inline JSON or file JSON, not both.', 2)
  }

  if (!hasInlineJson && !hasFilePath) return input.defaultValue

  let text = input.inlineJson
  if (isString(input.filePath)) {
    const filePath = input.filePath
    try {
      text = await readFile(resolve(cwd, filePath), 'utf8')
    } catch (error) {
      const message = AppError.getMessage(error)
      throw new WorkspaceCliError(
        'INPUT_FILE_ERROR',
        `Unable to read input file ${filePath}: ${message}`,
        2,
        {
          path: filePath,
          message,
        }
      )
    }
  }

  try {
    return JSON.parse(text ?? '') as T
  } catch (error) {
    const message = AppError.getMessage(error)
    throw new WorkspaceCliError('INVALID_JSON', 'Invalid JSON payload.', 2, { message })
  }
}

function toolCommandResult(command: WorkspaceCliRequest['command'], result: any): WorkspaceToolCommandResult {
  return {
    kind: `velaros.workspaceCli.${command}`,
    result,
    text: `${stringifyPretty(result)}\n`,
  }
}
