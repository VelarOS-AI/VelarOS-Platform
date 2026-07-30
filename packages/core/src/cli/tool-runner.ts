import { z } from 'zod'

import { AppError } from '../error.js'
import { Log } from '../logger/index.js'
import { isArray, isNotUndefined, isPresent, isRecord, isString } from '../typeGuards.js'
import { toNullable } from '../utils/nullish.js'
import { optionalWhen } from '../utils/optionalWhen.js'

import {
  parseVelarosCliGlobalFlags,
  readJsonPayload,
  stringFlag,
  validateCliArgs,
} from './args.js'
import { formatVelarosCliError, formatVelarosCliSuccess } from './output.js'
import {
  VelarosCliError,
  type VelarosCliRunOptions,
  type VelarosCliRunResult,
  type VelarosCliToolAvailability,
  type VelarosCliToolAvailabilityResolver,
  type VelarosCliToolLike,
  type VelarosCliToolMap,
  type VelarosCliWorkflowStep,
} from './types.js'

export interface RunToolCollectionCliOptions<TContext> extends VelarosCliRunOptions {
  namespace: string
  binName: string
  tools: VelarosCliToolMap<TContext>
  createContext: (input: { cwd: string }) => Promise<TContext> | TContext
  resolveToolAvailability?: VelarosCliToolAvailabilityResolver<TContext>
  helpText?: string
}

export async function runToolCollectionCli<TContext>(
  argv: string[],
  options: RunToolCollectionCliOptions<TContext>
): Promise<VelarosCliRunResult> {
  const startedAt = Date.now()
  let json = false
  let cwd = options.cwd ?? process.cwd()
  let command = 'help'

  try {
    const parsed = parseVelarosCliGlobalFlags(argv)
    json = parsed.json
    cwd = parsed.cwd ?? cwd
    command = parseToolCollectionCommand(parsed.argv)
    const result = await runParsedToolCollectionCommand({
      argv: parsed.argv,
      command,
      cwd,
      options,
    })

    return formatVelarosCliSuccess({
      namespace: options.namespace,
      command,
      cwd,
      durationMs: Date.now() - startedAt,
      result: result.result,
      json,
      text: result.text,
    })
  } catch (error) {
    return formatVelarosCliError(error, json || command.startsWith('tools'))
  }
}

function parseToolCollectionCommand(argv: readonly string[]): string {
  const command = argv[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') return 'help'
  if (command !== 'tools') {
    throw new VelarosCliError('UNKNOWN_COMMAND', `Unknown command: ${command}`, 2, { command })
  }

  const action = argv[1]
  switch (action) {
    case 'list':
      return 'tools.list'
    case 'call':
      return 'tools.call'
    case 'workflow':
      return 'tools.workflow'
  }

  const nestedCommand = action ? `tools.${action}` : 'tools'
  throw new VelarosCliError('UNKNOWN_COMMAND', `Unknown command: ${nestedCommand}`, 2, {
    command: nestedCommand,
  })
}

/** 单条已解析命令的执行入参（三个执行分支共用一份形状，别再逐处内联同形对象类型）。 */
interface ToolCollectionCommandInput<TContext> {
  argv: string[]
  command: string
  cwd: string
  options: RunToolCollectionCliOptions<TContext>
}

async function runParsedToolCollectionCommand<TContext>(
  input: ToolCollectionCommandInput<TContext>
): Promise<{ result: unknown; text?: string }> {
  switch (input.command) {
    case 'help':
      validateCliArgs({
        command: 'help',
        argv: input.argv,
        positionalIndexes: new Set(),
        booleanFlags: new Set(['--json']),
        valueFlags: new Set(['--cwd']),
      })
      return {
        result: {
          namespace: input.options.namespace,
          commands: ['help', 'tools list', 'tools call <toolName>', 'tools workflow'],
        },
        text:
          input.options.helpText ??
          `${input.options.binName}\n\nCommands:\n  help\n  tools list\n  tools call <toolName> [--args-json <json>|--args-file <file>|--input <file>]\n  tools workflow [--steps-json <json>|--steps-file <file>]\n`,
      }
    case 'tools.list':
      validateCliArgs({
        command: 'tools list',
        detailsCommand: 'tools.list',
        argv: input.argv,
        positionalIndexes: new Set([1]),
        booleanFlags: new Set(['--json']),
        valueFlags: new Set(['--cwd']),
      })
      return { result: { tools: await listToolDescriptors(input.options, input.cwd) } }
    case 'tools.call':
      return runToolCall(input)
    case 'tools.workflow':
      return runToolWorkflow(input)
    default:
      throw new VelarosCliError('UNKNOWN_COMMAND', `Unknown command: ${input.command}`, 2, {
        command: input.command,
      })
  }
}

async function runToolCall<TContext>(
  input: ToolCollectionCommandInput<TContext>
): Promise<{ result: unknown }> {
  validateCliArgs({
    command: 'tools call',
    detailsCommand: 'tools.call',
    argv: input.argv,
    positionalIndexes: new Set([1, 2]),
    booleanFlags: new Set(['--json']),
    valueFlags: new Set(['--cwd', '--args-json', '--args-file', '--input']),
  })
  const toolName = input.argv[2]
  if (!toolName || toolName.startsWith('--')) {
    throw new VelarosCliError('ARGUMENT_ERROR', 'tools call requires <toolName>.', 2)
  }

  const argsFile = stringFlag(input.argv, '--args-file') ?? stringFlag(input.argv, '--input')
  const args = await readJsonPayload<Record<string, unknown>>(input.cwd, {
    inlineJson: stringFlag(input.argv, '--args-json'),
    filePath: argsFile,
    defaultValue: {},
    label: 'tool call args',
  })
  if (!isRecord(args)) {
    throw new VelarosCliError('ARGUMENT_ERROR', 'Tool call args must be an object.', 2, {
      field: 'args',
    })
  }

  return { result: await executeTool(input.options, input.cwd, toolName, args) }
}

async function runToolWorkflow<TContext>(
  input: ToolCollectionCommandInput<TContext>
): Promise<{ result: unknown }> {
  validateCliArgs({
    command: 'tools workflow',
    detailsCommand: 'tools.workflow',
    argv: input.argv,
    positionalIndexes: new Set([1]),
    booleanFlags: new Set(['--json']),
    valueFlags: new Set(['--cwd', '--steps-json', '--steps-file', '--input']),
  })

  const steps = await readJsonPayload<VelarosCliWorkflowStep[]>(input.cwd, {
    inlineJson: stringFlag(input.argv, '--steps-json'),
    filePath: stringFlag(input.argv, '--steps-file') ?? stringFlag(input.argv, '--input'),
    defaultValue: [],
    label: 'workflow steps',
  })
  if (!isArray(steps)) {
    throw new VelarosCliError('ARGUMENT_ERROR', 'Workflow steps JSON must be an array.', 2)
  }

  const results = []
  for (const [index, step] of steps.entries()) {
    const validatedStep = validateWorkflowStep(step, index)
    const startedAt = Date.now()
    results.push({
      id: validatedStep.id ?? String(index + 1),
      tool: validatedStep.tool,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      result: await executeTool(input.options, input.cwd, validatedStep.tool, validatedStep.args ?? {}),
    })
  }

  return { result: { results } }
}

async function executeTool<TContext>(
  options: RunToolCollectionCliOptions<TContext>,
  cwd: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = options.tools[toolName]
  if (!isPresent(tool)) {
    throw new VelarosCliError('UNKNOWN_TOOL', `Unknown tool: ${toolName}`, 2, { toolName })
  }

  const context = await options.createContext({ cwd })
  const availability = resolveToolAvailability(options, toolName, tool, context)
  if (!availability.available) {
    throw new VelarosCliError(
      'HOST_CAPABILITY_REQUIRED',
      availability.message ?? `Tool requires host capability: ${toolName}`,
      1,
      {
        toolName,
        availabilityReason: availability.reason,
      }
    )
  }

  const parsed = tool.schema.safeParse(args)
  if (!parsed.success) {
    throw new VelarosCliError('ARGUMENT_ERROR', `${toolName} schema rejected input.`, 2, {
      toolName,
      error: AppError.getMessage(parsed.error),
    })
  }

  return tool.execute(parsed.data, context)
}

function validateWorkflowStep(step: unknown, stepIndex: number): VelarosCliWorkflowStep {
  if (!isRecord(step)) {
    throw new VelarosCliError('ARGUMENT_ERROR', 'Workflow step must be an object.', 2, {
      stepIndex,
    })
  }
  const tool = optionalWhen(isString, step.tool)?.trim()
  if (!tool) {
    throw new VelarosCliError('ARGUMENT_ERROR', 'Workflow step requires a tool.', 2, {
      stepIndex,
      field: 'tool',
    })
  }
  const stepArgs = step.args
  if (isNotUndefined(stepArgs) && !isRecord(stepArgs)) {
    throw new VelarosCliError('ARGUMENT_ERROR', 'Workflow step args must be an object.', 2, {
      stepIndex,
      field: 'args',
    })
  }

  return {
    id: optionalWhen(isString, step.id),
    tool,
    args: optionalWhen(isRecord, stepArgs),
  }
}

async function listToolDescriptors<TContext>(
  options: RunToolCollectionCliOptions<TContext>,
  cwd: string
): Promise<unknown[]> {
  const context = await options.createContext({ cwd })
  return Object.entries(options.tools).map(([name, tool]) =>
    toolDescriptor(name, tool, resolveToolAvailability(options, name, tool, context))
  )
}

function resolveToolAvailability<TContext>(
  options: RunToolCollectionCliOptions<TContext>,
  name: string,
  tool: VelarosCliToolLike<TContext>,
  context: TContext
): VelarosCliToolAvailability {
  const explicitAvailability = options.resolveToolAvailability?.({ name, tool, context })
  if (isPresent(explicitAvailability)) return explicitAvailability

  const available = tool.isAvailable ? tool.isAvailable(context) : true
  return available
    ? { available: true, reason: 'available' }
    : {
        available: false,
        reason: 'tool-state-unavailable',
        message: `Tool is not available in the current CLI context: ${name}`,
      }
}

function toolDescriptor(
  name: string,
  tool: {
    description: string
    schema: unknown
    permissions?: readonly string[]
    capabilities?: unknown
    exposure?: unknown
  },
  availability: VelarosCliToolAvailability
) {
  return {
    name,
    description: tool.description,
    permissions: tool.permissions ?? [],
    capabilities: toNullable(tool.capabilities),
    exposure: toNullable(tool.exposure),
    availability,
    inputSchema: schemaToJson(tool.schema),
  }
}

function schemaToJson(schema: unknown): unknown {
  try {
    return z.toJSONSchema(schema as any, { io: 'input' })
  } catch (error) {
    Log.tag('VelarosCli').debug('Zod schema 转 JSON schema 失败', { error })
    return null
  }
}
