import { readFile } from 'node:fs/promises'

import {
  isBlank,
  isNotNull,
  isPlainObject,
  isPresent,
  isString,
  toOptional,
} from '@velaros-ai/core'

import { installVelarHostComputer } from './computer-installer'
import { createVelarHostPaths } from './data-root'
import {
  installVelarHostShutdownHandlers,
  startVelarHost,
  type VelarHostPublicStatus,
  type VelarHostRuntime,
} from './host'

const runningHosts = new Set<VelarHostRuntime>()

export interface ServeCliRunResult {
  readonly text: string
  readonly exitCode: number
  readonly envelope?: unknown
}

export interface ServeCliRunOptions {
  readonly cwd?: string
}

interface ParsedServeArgs {
  command: 'start' | 'status' | 'control' | 'computer-install' | 'help'
  dataRoot?: string
  workspaceRoot?: string
  pythonCommand?: string
  json: boolean
}

function parseServeArgs(argv: string[]): ParsedServeArgs {
  const commandValue = argv[0]
  let command: ParsedServeArgs['command'] | undefined
  let startIndex = 0
  if (!isPresent(commandValue) || commandValue.startsWith('-')) command = 'start'
  else if (commandValue === 'start' || commandValue === 'status' || commandValue === 'control') {
    command = commandValue
    startIndex = 1
  } else if (commandValue === 'computer' && argv[1] === 'install') {
    command = 'computer-install'
    startIndex = 2
  } else if (commandValue === 'help' || commandValue === '--help' || commandValue === '-h') {
    command = 'help'
    startIndex = 1
  }
  if (!isPresent(command)) throw new Error(`Unknown serve command: ${commandValue}`)
  let dataRoot: string | undefined
  let workspaceRoot: string | undefined
  let pythonCommand: string | undefined
  let json = false
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument === '--data-root' || argument === '--workspace-root' || argument === '--python') {
      const value = argv[++index]
      if (!isPresent(value) || isBlank(value)) {
        throw new Error(`${argument} requires a path`)
      }
      if (argument === '--data-root') dataRoot = value
      else if (argument === '--workspace-root') workspaceRoot = value
      else pythonCommand = value
      continue
    }
    if (argument === '--help' || argument === '-h') return { command: 'help', json }
    throw new Error(`Unknown serve option: ${argument}`)
  }
  if (isPresent(workspaceRoot) && command !== 'start') {
    throw new Error('--workspace-root is only valid for velaros serve start')
  }
  if (isPresent(pythonCommand) && command !== 'computer-install') {
    throw new Error('--python is only valid for velaros serve computer install')
  }
  return { command, dataRoot, workspaceRoot, pythonCommand, json }
}

function serveHelp(): string {
  return `Velar Host

Commands:
  velaros serve [start] [--workspace-root PATH] [--data-root PATH]
  velaros serve status [--data-root PATH] [--json]
  velaros serve control [--data-root PATH]
  velaros serve computer install [--data-root PATH] [--python COMMAND] [--json]

The start command runs a headless Kernel host and prints its control URL and extension pairing code.
`
}

export async function runServeCli(
  argv: string[],
  options: ServeCliRunOptions = {},
): Promise<ServeCliRunResult> {
  try {
    const parsed = parseServeArgs(argv)
    if (parsed.command === 'help') return { text: serveHelp(), exitCode: 0 }
    if (parsed.command === 'status') {
      const status = await readHostStatus(parsed.dataRoot)
      const result = {
        running: isNotNull(status) && isProcessAlive(status.pid),
        status,
      }
      return {
        text: parsed.json
          ? `${JSON.stringify(result)}\n`
          : !isNotNull(status)
            ? 'Velar Host is not running.\n'
            : `Velar Host ${result.running ? 'is running' : 'has a stale status file'} (pid ${status.pid}).\n`,
        exitCode: result.running ? 0 : 1,
        envelope: result,
      }
    }
    if (parsed.command === 'control') {
      const status = await readHostStatus(parsed.dataRoot)
      if (!isNotNull(status) || !isProcessAlive(status.pid)) return { text: 'Velar Host is not running.\n', exitCode: 1 }
      const token = (await readFile(createVelarHostPaths(parsed.dataRoot).controlTokenPath, 'utf8'))
        .trim()
      if (!/^[A-Za-z0-9_-]{40,128}$/u.test(token)) {
        throw new Error('Velar Host control token is invalid')
      }
      const controlUrl = `${status.control.endpoint}/#token=${encodeURIComponent(token)}`
      return {
        text: parsed.json
          ? `${JSON.stringify({ controlUrl })}\n`
          : `${controlUrl}\n`,
        exitCode: 0,
      }
    }
    if (parsed.command === 'computer-install') {
      const paths = createVelarHostPaths(parsed.dataRoot)
      const installation = await installVelarHostComputer({
        dataRoot: paths.dataRoot,
        pythonCommand: toOptional(parsed.pythonCommand),
      })
      return {
        text: parsed.json
          ? `${JSON.stringify(installation)}\n`
          : installation.installed
            ? `Computer runtime installed at ${installation.packageRoot}.\n`
            : `Computer runtime is already installed at ${installation.packageRoot}.\n`,
        exitCode: 0,
        envelope: installation,
      }
    }
    const runtime = await startVelarHost({
      dataRoot: parsed.dataRoot,
      workspaceRoot: parsed.workspaceRoot ?? options.cwd,
    })
    runningHosts.add(runtime)
    const removeHandlers = installVelarHostShutdownHandlers(runtime)
    const originalStop = runtime.stop.bind(runtime)
    runtime.stop = async () => {
      removeHandlers()
      runningHosts.delete(runtime)
      await originalStop()
    }
    const result = runtime.status
    return {
      text: parsed.json
        ? `${JSON.stringify(result)}\n`
        : [
            `Velar Host ${result.version} started (pid ${result.pid}).`,
            `Workspace: ${result.workspaceRoot}`,
            `Extension bridge: ${result.extension.endpoint}`,
            `Pairing code: ${result.extension.pairingCode ?? 'resume existing device'}`,
            `Control: ${runtime.controlUrl}`,
            `Data root: ${result.dataRoot}`,
            '',
          ].join('\n'),
      exitCode: 0,
      envelope: result,
    }
  } catch (error) {
    return {
      text: `${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1,
    }
  }
}

async function readHostStatus(dataRoot?: string): Promise<Nullable<VelarHostPublicStatus>> {
  try {
    const value: unknown = JSON.parse(
      await readFile(createVelarHostPaths(dataRoot).statusPath, 'utf8'),
    )
    return isVelarHostPublicStatus(value) ? value : null
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

function isVelarHostPublicStatus(value: unknown): value is VelarHostPublicStatus {
  if (!isPlainObject(value)) return false
  const control = Reflect.get(value, 'control')
  return Reflect.get(value, 'schemaVersion') === 1
    && Number.isInteger(Reflect.get(value, 'pid'))
    && isPlainObject(control)
    && isString(Reflect.get(control, 'endpoint'))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error, 'EPERM')
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
