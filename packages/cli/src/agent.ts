import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { optionalWhen } from '@velaros-ai/core'
import {
  asRecord as readJsonRecordValue,
  readRawString as readString,
} from '@velaros-ai/core/utils/unknownJsonRecord'

import { formatVelarosCliError, formatVelarosCliSuccess } from './output.js'
import {
  VelarosCliError,
  type VelarosCliRunOptions,
  type VelarosCliRunResult,
} from './types.js'

const TaskArtifactRoot = '.velaros/agent-runs'
const AgentCommandNames = ['help', 'manifest', 'status'] as const

const AgentCommandSummaries: Record<(typeof AgentCommandNames)[number], string> = {
  help: 'Show the Agent CLI command surface.',
  manifest: 'Print the built-in Agent CLI manifest.',
  status: 'Read the latest or selected agent task artifact status.',
}

const AgentHelp = `VelarOS Agent CLI

Commands:
  help
  manifest ...
  status --workspace-root <path> [--task-id <id>|--latest] [--full] [--json]
`

export async function runAgentCli(
  argv: string[],
  options: VelarosCliRunOptions = {}
): Promise<VelarosCliRunResult> {
  const startedAt = Date.now()
  const json = argv.includes('--json')
  const cwd = options.cwd ?? process.cwd()
  const request = parseAgentArgs(argv)

  try {
    if (isHelpCommand(request.command)) return formatVelarosCliSuccess({
        namespace: 'agent',
        command: 'help',
        cwd,
        durationMs: Date.now() - startedAt,
        result: {
          commands: AgentCommandNames.map((name) => ({
            name,
            summary: AgentCommandSummaries[name],
          })),
        },
        json,
        text: AgentHelp,
      })

    if (request.command === 'manifest') return formatVelarosCliSuccess({
        namespace: 'agent',
        command: 'manifest',
        cwd,
        durationMs: Date.now() - startedAt,
        result: {
          namespace: 'agent',
          commands: [...AgentCommandNames],
          status: 'ready',
          entrypoint: 'velaros agent',
          artifactRoot: TaskArtifactRoot,
        },
        json,
        text: AgentHelp,
      })

    if (request.command === 'status') {
      const result = readAgentTaskStatus(request.args, cwd)
      return formatVelarosCliSuccess({
        namespace: 'agent',
        command: 'status',
        cwd: result.workspaceRoot,
        durationMs: Date.now() - startedAt,
        result,
        json,
        text: `${result.taskId}: ${result.status}\n`,
      })
    }

    throw new VelarosCliError('UNKNOWN_COMMAND', `Unknown agent command: ${request.command}`, 2, {
      namespace: 'agent',
      command: request.command,
      availableCommands: AgentCommandNames,
    })
  } catch (error) {
    return formatVelarosCliError(error, json)
  }
}

function parseAgentArgs(argv: string[]): { command: string; args: string[] } {
  const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'))
  if (commandIndex === -1) return {
      command: 'help',
      args: argv,
    }

  return {
    command: argv[commandIndex],
    args: [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)],
  }
}

function isHelpCommand(commandName: string): boolean {
  return commandName === 'help' || commandName === '--help' || commandName === '-h'
}

interface AgentTaskStatusResult {
  workspaceRoot: string
  taskId: string
  status: string
  taskJsonPath: string
  ledger?: Record<string, unknown>
}

function readAgentTaskStatus(args: string[], cwd: string): AgentTaskStatusResult {
  const workspaceRoot = resolve(readOption(args, '--workspace-root') ?? cwd)
  const taskId = readOption(args, '--task-id')
  const full = args.includes('--full')
  const taskJsonPath = resolveTaskJsonPath(workspaceRoot, taskId)
  const ledger = readJsonRecord(taskJsonPath)
  const resultRecord = optionalRecord(ledger.result)
  const resolvedTaskId = readString(ledger, 'taskId') ?? taskId ?? 'unknown'
  const status = readString(resultRecord, 'status') ?? readString(ledger, 'status') ?? 'unknown'

  return {
    workspaceRoot,
    taskId: resolvedTaskId,
    status,
    taskJsonPath,
    ledger: optionalWhen(full, ledger),
  }
}

/**
 * 把「命令行 / 指针文件给的任务标识」解析成一个磁盘路径。
 *
 * 导览（§5.3b ④安全门）
 * - **挡什么**：`velaros agent status` 会把解析到的 JSON 原样打回 stdout。任务标识有两条来源都不
 *   受信——`--task-id` 来自命令行，`latest-task.json` 的 `taskId`/`taskJsonPath` 来自**仓库里的
 *   文件**（克隆一个恶意仓库就能塞）。不设门的话它就是一个「读任意文件并打印」的原语。
 * - **门为什么在这一层**：这是唯一一处把外部标识拼进 `resolve()` 的地方；放到读文件处就晚了
 *   （那时已经分不清路径是怎么来的）。
 * - **两条轴都要挡，且判据不同**：`taskId` 是**目录名**，只许是单段名字（`assertSafeTaskId`）；
 *   `taskJsonPath` 是**相对路径**，允许多段，所以只能按「解析后是否仍在 workspaceRoot 内」判
 *   （`assertPathWithinWorkspace`）。曾经只挡了前者——后者是 2026-07-30 Q3b 补上的缺口。
 * - **失败方向**：任何存疑一律拒（exitCode 2），不做「清洗后继续」。
 */
function resolveTaskJsonPath(workspaceRoot: string, taskId: Nullable<string>): string {
  if (taskId) {
    assertSafeTaskId(taskId)
    return resolve(workspaceRoot, TaskArtifactRoot, 'tasks', taskId, 'task.json')
  }

  const latestPath = resolve(workspaceRoot, TaskArtifactRoot, 'latest-task.json')
  const latest = readJsonRecord(latestPath)
  const taskJsonPath = readString(latest, 'taskJsonPath')
  if (taskJsonPath)
    return assertPathWithinWorkspace(resolve(workspaceRoot, taskJsonPath), workspaceRoot, latestPath)

  const latestTaskId = readString(latest, 'taskId')
  if (!latestTaskId) {
    throw new VelarosCliError('TASK_NOT_FOUND', 'Latest agent task pointer has no task id.', 1, {
      latestPath,
    })
  }
  assertSafeTaskId(latestTaskId)
  return resolve(workspaceRoot, TaskArtifactRoot, 'tasks', latestTaskId, 'task.json')
}

function assertSafeTaskId(taskId: string): void {
  if (!taskId.trim() || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) {
    throw new VelarosCliError('INVALID_TASK_ID', `Invalid agent task id: ${taskId}`, 2, {
      taskId,
    })
  }
}

function assertPathWithinWorkspace(
  resolvedPath: string,
  workspaceRoot: string,
  latestPath: string
): string {
  const relativePath = relative(workspaceRoot, resolvedPath)
  const escapesRoot =
    relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
  if (escapesRoot) {
    throw new VelarosCliError(
      'INVALID_TASK_POINTER',
      'Latest agent task pointer escapes the workspace root.',
      2,
      { latestPath, resolvedPath, workspaceRoot }
    )
  }
  return resolvedPath
}

function readOption(args: string[], name: string): Nullable<string> {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new VelarosCliError('INVALID_ARGUMENT', `Missing value for ${name}.`, 2, {
      option: name,
    })
  }
  return value
}

function readJsonRecord(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new VelarosCliError('TASK_NOT_FOUND', `Agent task artifact does not exist: ${path}`, 1, {
      path,
    })
  }

  try {
    const record = readJsonRecordValue(JSON.parse(readFileSync(path, 'utf8')))
    if (record) return record
    throw new VelarosCliError('INVALID_TASK_JSON', `Expected JSON object in ${path}.`, 1, {
      path,
    })
  } catch (error) {
    if (error instanceof VelarosCliError) throw error
    throw new VelarosCliError('INVALID_TASK_JSON', `Invalid agent task artifact JSON: ${path}`, 1, {
      path,
    })
  }
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return readJsonRecordValue(value) ?? {}
}
