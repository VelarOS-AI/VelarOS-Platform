import { inferWorkspaceCliJsonMode, parseWorkspaceCliArgs } from './args.js'
import { runHumanWorkspaceCommand } from './human-commands.js'
import { formatWorkspaceCliError, formatWorkspaceCliSuccess } from './output.js'
import { runWorkspaceToolCommand } from './tool-commands.js'
import type { WorkspaceCliRunResult } from './types.js'
import { createWorkspaceCliWorkspace, persistWorkspaceCliState } from './workspace-factory.js'

export interface RunWorkspaceCliOptions {
  cwd?: string
}

export async function runWorkspaceCli(
  argv: string[],
  options: RunWorkspaceCliOptions = {}
): Promise<WorkspaceCliRunResult> {
  let json = inferWorkspaceCliJsonMode(argv)
  const startedAt = Date.now()

  try {
    const request = parseWorkspaceCliArgs(argv)
    json = request.json
    const cwd = request.cwd ?? options.cwd ?? process.cwd()
    const workspace = await createWorkspaceCliWorkspace({ cwd })
    const result = isToolsCommand(request.command)
      ? await runWorkspaceToolCommand({ request, workspace, cwd })
      : await runHumanWorkspaceCommand({ request, workspace, cwd })
    try {
      await persistWorkspaceCliState(workspace)
    } catch {
      // arch-guard:silent-catch-ok CLI 状态只是跨进程缓存，写入失败不能覆盖主命令结果。
    }

    return formatWorkspaceCliSuccess({
      kind: result.kind,
      workspaceRoot: workspace.root,
      durationMs: Date.now() - startedAt,
      result: result.result,
      json,
      text: result.text,
      exitCode: result.exitCode,
    })
  } catch (error) {
    return formatWorkspaceCliError(error, json)
  }
}

function isToolsCommand(command: string): boolean {
  return command.startsWith('tools.')
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd()
): Promise<WorkspaceCliRunResult> {
  const result = await runWorkspaceCli(argv, { cwd })
  const stream = result.exitCode === 0 ? process.stdout : process.stderr
  stream.write(result.text)
  process.exitCode = result.exitCode
  return result
}
