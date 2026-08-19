import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  AppError,
  isBlank,
  isNotNull,
  isPlainObject,
  isPresent,
  isString,
  stringifyPretty,
  toOptional,
} from '@velaros-ai/core'

import { installVelarHostComputer } from './computer-installer'
import type { VelarHostConfigSnapshot } from './config'
import { createVelarHostPaths } from './data-root'
import type { VelarHostExtensionBridgeStatus } from './extension-bridge'
import {
  installVelarHostShutdownHandlers,
  startVelarHost,
  type VelarHostPublicStatus,
  type VelarHostRuntime,
} from './host'
import {
  callVelarHostManagement,
  VelarHostManagementError,
  type VelarHostManagementOperation,
} from './management-ipc'
import type { VelarHostRemoteNodeStatus } from './remote-node'

const runningHosts = new Set<VelarHostRuntime>()

export interface ServeCliRunResult {
  readonly command: string
  readonly text: string
  readonly exitCode: number
  readonly envelope?: unknown
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly details: Record<string, unknown>
  }
}

export interface ServeCliRunOptions {
  readonly cwd?: string
  /** Foreground, human-readable Host events. JSON mode deliberately suppresses this stream. */
  readonly onEvent?: (text: string) => void
}

type ServeCommand =
  | 'start'
  | 'status'
  | 'config-show'
  | 'config-apply'
  | 'computer-probe'
  | 'computer-install'
  | 'extension-pair'
  | 'extension-disconnect'
  | 'remote-pair'
  | 'remote-revoke'
  | 'help'

interface ParsedServeArgs {
  command: ServeCommand
  dataRoot?: string
  projectRoot?: string
  pythonCommand?: string
  filePath?: string
  json: boolean
}

interface ManagementStatusPayload {
  readonly host: VelarHostPublicStatus
  readonly config: VelarHostConfigSnapshot
  readonly computerAvailability: unknown
  readonly installation?: unknown
  readonly pairing?: {
    readonly code: string
    readonly expiresAt: number
  }
}

class ServeCliError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ServeCliError'
  }
}

function parseServeArgs(argv: string[]): ParsedServeArgs {
  const commandValue = argv[0]
  let command: ServeCommand | undefined
  let startIndex = 0
  if (!isPresent(commandValue) || commandValue.startsWith('-')) command = 'start'
  else if (commandValue === 'start' || commandValue === 'status') {
    command = commandValue
    startIndex = 1
  } else if (commandValue === 'config' && argv[1] === 'show') {
    command = 'config-show'
    startIndex = 2
  } else if (commandValue === 'config' && argv[1] === 'apply') {
    command = 'config-apply'
    startIndex = 2
  } else if (commandValue === 'computer' && argv[1] === 'probe') {
    command = 'computer-probe'
    startIndex = 2
  } else if (commandValue === 'computer' && argv[1] === 'install') {
    command = 'computer-install'
    startIndex = 2
  } else if (commandValue === 'extension' && argv[1] === 'pair') {
    command = 'extension-pair'
    startIndex = 2
  } else if (commandValue === 'extension' && argv[1] === 'disconnect') {
    command = 'extension-disconnect'
    startIndex = 2
  } else if (commandValue === 'remote' && argv[1] === 'pair') {
    command = 'remote-pair'
    startIndex = 2
  } else if (commandValue === 'remote' && argv[1] === 'revoke') {
    command = 'remote-revoke'
    startIndex = 2
  } else if (commandValue === 'help' || commandValue === '--help' || commandValue === '-h') {
    command = 'help'
    startIndex = 1
  }
  if (!isPresent(command)) {
    throw new ServeCliError(
      'UNKNOWN_COMMAND',
      `Unknown serve command: ${argv.slice(0, 2).join(' ')}`,
      2,
      { command: commandValue },
    )
  }

  let dataRoot: string | undefined
  let projectRoot: string | undefined
  let pythonCommand: string | undefined
  let filePath: string | undefined
  let json = false
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      json = true
      continue
    }
    if (
      argument === '--data-root'
      || argument === '--project-root'
      || argument === '--workspace-root'
      || argument === '--python'
      || argument === '--file'
    ) {
      const value = argv[++index]
      if (!isPresent(value) || isBlank(value)) {
        throw new ServeCliError('ARGUMENT_ERROR', `${argument} requires a value`, 2, {
          flag: argument,
        })
      }
      if (argument === '--data-root') dataRoot = value
      else if (argument === '--project-root' || argument === '--workspace-root') projectRoot = value
      else if (argument === '--python') pythonCommand = value
      else filePath = value
      continue
    }
    if (argument === '--help' || argument === '-h') return { command: 'help', json }
    throw new ServeCliError('ARGUMENT_ERROR', `Unknown serve option: ${argument}`, 2, {
      flag: argument,
    })
  }
  if (isPresent(projectRoot) && command !== 'start') {
    throw new ServeCliError(
      'ARGUMENT_ERROR',
      '--project-root is only valid for velaros serve start',
      2,
      { flag: '--project-root', command },
    )
  }
  if (isPresent(pythonCommand) && command !== 'computer-install') {
    throw new ServeCliError(
      'ARGUMENT_ERROR',
      '--python is only valid for velaros serve computer install',
      2,
      { flag: '--python', command },
    )
  }
  if (command === 'config-apply' && !isPresent(filePath)) {
    throw new ServeCliError(
      'ARGUMENT_ERROR',
      'velaros serve config apply requires --file PATH',
      2,
      { flag: '--file', command },
    )
  }
  if (isPresent(filePath) && command !== 'config-apply') {
    throw new ServeCliError(
      'ARGUMENT_ERROR',
      '--file is only valid for velaros serve config apply',
      2,
      { flag: '--file', command },
    )
  }
  return { command, dataRoot, projectRoot, pythonCommand, filePath, json }
}

function serveHelp(): string {
  return `Velar Host

Commands:
  velaros serve [start] [--project-root PATH] [--data-root PATH]
  velaros serve status [--data-root PATH] [--json]
  velaros serve config show [--data-root PATH] [--json]
  velaros serve config apply --file PATH [--data-root PATH] [--json]
  velaros serve computer probe [--data-root PATH] [--json]
  velaros serve computer install [--data-root PATH] [--python COMMAND] [--json]
  velaros serve extension pair [--data-root PATH] [--json]
  velaros serve extension disconnect [--data-root PATH] [--json]
  velaros serve remote pair [--data-root PATH] [--json]
  velaros serve remote revoke [--data-root PATH] [--json]

The start command runs Velar Host in the foreground. Management commands use OS-local IPC.
`
}

export async function runServeCli(
  argv: string[],
  options: ServeCliRunOptions = {},
): Promise<ServeCliRunResult> {
  let command = 'unknown'
  try {
    const parsed = parseServeArgs(argv)
    command = commandName(parsed.command)
    if (parsed.command === 'help') return {
      command,
      text: serveHelp(),
      exitCode: 0,
      envelope: {
        commands: [
          'start',
          'status',
          'config show',
          'config apply',
          'computer probe',
          'computer install',
          'extension pair',
          'extension disconnect',
          'remote pair',
          'remote revoke',
        ],
      },
    }
    if (parsed.command === 'start') {
      return await startHost(parsed, options)
    }
    if (parsed.command === 'computer-install' && isPresent(parsed.pythonCommand)) {
      return await installComputerOffline(command, parsed)
    }
    if (parsed.command === 'computer-install') {
      const status = await readHostStatus(parsed.dataRoot)
      if (!isNotNull(status) || !isProcessAlive(status.pid)) {
        return await installComputerOffline(command, parsed)
      }
    }

    const status = await requireRunningHost(parsed.dataRoot)
    const operation = managementOperation(parsed.command)
    const payload = parsed.command === 'config-apply'
      ? JSON.parse(await readFile(
          resolve(options.cwd ?? process.cwd(), parsed.filePath!),
          'utf8',
        )) as unknown
      : undefined
    const result = await callVelarHostManagement<unknown>(
      status.management.endpoint,
      operation,
      payload,
    )
    return {
      command,
      text: parsed.json
        ? `${JSON.stringify(commandEnvelope(parsed.command, result))}\n`
        : formatManagementResult(parsed.command, result),
      exitCode: 0,
      envelope: commandEnvelope(parsed.command, result),
    }
  } catch (error) {
    const normalized = error instanceof ServeCliError
      ? error
      : error instanceof VelarHostManagementError
        ? new ServeCliError(error.code, error.message, 1)
        : new ServeCliError('EXECUTION_ERROR', AppError.getMessage(error), 1)
    return {
      command,
      text: `${normalized.message}\n`,
      exitCode: normalized.exitCode,
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    }
  }
}

async function startHost(
  parsed: ParsedServeArgs,
  options: ServeCliRunOptions,
): Promise<ServeCliRunResult> {
  const runtime = await startVelarHost({
    dataRoot: parsed.dataRoot,
    projectRoot: parsed.projectRoot ?? options.cwd,
  })
  runningHosts.add(runtime)
  const stopReporting = parsed.json || !isPresent(options.onEvent)
    ? () => undefined
    : attachTerminalReporter(runtime, options.onEvent)
  const removeHandlers = installVelarHostShutdownHandlers(runtime)
  const originalStop = runtime.stop.bind(runtime)
  runtime.stop = async () => {
    removeHandlers()
    stopReporting()
    runningHosts.delete(runtime)
    await originalStop()
  }
  const result = runtime.status
  return {
    command: 'start',
    text: parsed.json
      ? `${JSON.stringify(result)}\n`
      : formatStartStatus(runtime),
    exitCode: 0,
    envelope: result,
  }
}

async function installComputerOffline(
  command: string,
  parsed: ParsedServeArgs,
): Promise<ServeCliRunResult> {
  const paths = createVelarHostPaths(parsed.dataRoot)
  const installation = await installVelarHostComputer({
    dataRoot: paths.dataRoot,
    pythonCommand: toOptional(parsed.pythonCommand),
  })
  return {
    command,
    text: parsed.json
      ? `${JSON.stringify(installation)}\n`
      : installation.installed
        ? `Computer runtime installed at ${installation.packageRoot}.\n`
        : `Computer runtime is already installed at ${installation.packageRoot}.\n`,
    exitCode: 0,
    envelope: installation,
  }
}

async function requireRunningHost(dataRoot?: string): Promise<VelarHostPublicStatus> {
  const status = await readHostStatus(dataRoot)
  if (!isNotNull(status) || !isProcessAlive(status.pid)) {
    throw new ServeCliError('HOST_NOT_RUNNING', 'Velar Host is not running.', 1)
  }
  return status
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

function commandName(command: ServeCommand): string {
  return command.replace('-', '.')
}

function managementOperation(command: Exclude<ServeCommand, 'start' | 'help'>): VelarHostManagementOperation {
  switch (command) {
    case 'status': return 'status'
    case 'config-show': return 'config.show'
    case 'config-apply': return 'config.apply'
    case 'computer-probe': return 'computer.probe'
    case 'computer-install': return 'computer.install'
    case 'extension-pair': return 'extension.pair'
    case 'extension-disconnect': return 'extension.disconnect'
    case 'remote-pair': return 'remote.pair'
    case 'remote-revoke': return 'remote.revoke'
  }
}

function commandEnvelope(command: ServeCommand, result: unknown): unknown {
  if (command === 'status') return { running: true, ...(isPlainObject(result) ? result : { result }) }
  return result
}

function formatManagementResult(command: ServeCommand, result: unknown): string {
  if (command === 'status' && isManagementStatusPayload(result)) {
    return [
      `Velar Host is running (pid ${result.host.pid}).`,
      `Project: ${result.host.projectRoot}`,
      `Data root: ${result.host.dataRoot}`,
      `Extension: ${result.host.extension.connected ? 'connected' : 'waiting for pairing'}`,
      describeRemoteNode(result.host.remoteNode),
      '',
    ].join('\n')
  }
  if (command === 'config-show' && isPlainObject(result)) return `${stringifyPretty(result)}\n`
  if (command === 'config-apply') return 'Host configuration applied.\n'
  if (command === 'computer-probe' && isManagementStatusPayload(result)) {
    const available = isPlainObject(result.computerAvailability)
      && Reflect.get(result.computerAvailability, 'available') === true
    return `Computer runtime: ${available ? 'available' : 'unavailable'}.\n`
  }
  if (command === 'computer-install' && isManagementStatusPayload(result)) {
    return 'Computer runtime installed and checked by the running Host.\n'
  }
  if ((command === 'extension-pair' || command === 'extension-disconnect') && isManagementStatusPayload(result)) {
    return formatPairing('Extension', result.host.extension.pairingCode, result.host.extension.pairingExpiresAt)
  }
  if (command === 'remote-pair' && isManagementStatusPayload(result) && isPresent(result.pairing)) {
    return formatPairing('Remote node', result.pairing.code, result.pairing.expiresAt)
  }
  if (command === 'remote-revoke') return 'Remote node pairing revoked.\n'
  return `${stringifyPretty(result)}\n`
}

function formatStartStatus(runtime: VelarHostRuntime): string {
  const status = runtime.status
  const config = runtime.config.snapshot().value
  return [
    `Velar Host ${status.version} started in the foreground (pid ${status.pid}).`,
    `Project: ${status.projectRoot}`,
    `Data root: ${status.dataRoot}`,
    `Kernel modules: ${status.kernel.moduleIds.join(', ')}`,
    'Capabilities:',
    `  Project: ${capabilityWords(config.capabilities.project)}`,
    `  System: ${capabilityWords(config.capabilities.system)}`,
    `  Computer: ${capabilityWords(config.capabilities.computer)}`,
    `  Remote node: ${config.remoteNode.enabled ? 'enabled' : 'disabled'}`,
    `Extension bridge: ${status.extension.endpoint}`,
    ...formatPairingLines(
      'Extension pairing',
      status.extension.pairingCode,
      status.extension.pairingExpiresAt,
    ),
    `Management: local ${status.management.kind} IPC (${status.management.endpoint})`,
    describeRemoteNode(status.remoteNode),
    'Press Ctrl+C to stop.',
    '',
  ].join('\n')
}

function capabilityWords(value: Readonly<Record<string, boolean>>): string {
  return Object.entries(value)
    .map(([name, enabled]) => `${name}=${enabled ? 'yes' : 'no'}`)
    .join(', ')
}

function formatPairing(
  label: string,
  code: Nullable<string>,
  expiresAt: Nullable<number>,
): string {
  return `${formatPairingLines(label, code, expiresAt).join('\n')}\n`
}

function formatPairingLines(
  label: string,
  code: Nullable<string>,
  expiresAt: Nullable<number>,
): string[] {
  if (!isNotNull(code) || !isNotNull(expiresAt)) return [`${label}: unavailable`]
  return [
    `${label} code: ${code}`,
    `${label} expires: ${new Date(expiresAt).toISOString()}`,
  ]
}

function attachTerminalReporter(
  runtime: VelarHostRuntime,
  write: (text: string) => void,
): () => void {
  let extension = runtime.status.extension
  let remoteNode = runtime.status.remoteNode
  let configRevision = runtime.config.snapshot().revision
  const emit = (message: string): void => write(`[${new Date().toISOString()}] ${message}\n`)
  const unsubscribeExtension = runtime.extensionBridge.subscribeStatus((next) => {
    if (next.connected !== extension.connected) {
      emit(next.connected
        ? `Extension connected${isNotNull(next.provider) ? ` (${next.provider})` : ''}.`
        : 'Extension disconnected.')
    }
    if (next.pairingCode !== extension.pairingCode && isNotNull(next.pairingCode)) {
      emit(`Extension pairing code: ${next.pairingCode}; expires ${formatTimestamp(next.pairingExpiresAt)}.`)
    } else if (isNotNull(extension.pairingCode) && !isNotNull(next.pairingCode)) {
      emit('Extension pairing code expired or was consumed.')
    }
    if (next.surfaceCount !== extension.surfaceCount) {
      emit(`Extension surfaces: ${next.surfaceCount}.`)
    }
    if (activityKey(next.activity) !== activityKey(extension.activity) && isNotNull(next.activity)) {
      emit([
        'Extension event',
        next.activity.eventType,
        isNotNull(next.activity.toolName) ? `tool=${next.activity.toolName}` : null,
        isNotNull(next.activity.status) ? `status=${next.activity.status}` : null,
      ].filter(isString).join(' · '))
    }
    extension = next
  })
  const unsubscribeRemote = runtime.remoteNode.subscribeStatus((next) => {
    if (next.enabled !== remoteNode.enabled || next.address !== remoteNode.address) {
      emit(next.enabled ? `Remote node listening at ${next.address ?? 'starting'}.` : 'Remote node disabled.')
    }
    if (next.connected !== remoteNode.connected) {
      emit(next.connected ? 'Remote node client connected.' : 'Remote node client disconnected.')
    }
    const nextClient = next.paired?.clientName ?? null
    const previousClient = remoteNode.paired?.clientName ?? null
    if (nextClient !== previousClient) {
      emit(isNotNull(nextClient) ? `Remote node paired with ${nextClient}.` : 'Remote node pairing revoked.')
    }
    remoteNode = next
  })
  const unsubscribeConfig = runtime.config.subscribe((snapshot) => {
    if (snapshot.revision !== configRevision) {
      configRevision = snapshot.revision
      emit(`Host capabilities updated (${snapshot.revision}).`)
    }
  })
  return () => {
    unsubscribeExtension()
    unsubscribeRemote()
    unsubscribeConfig()
  }
}

function activityKey(activity: VelarHostExtensionBridgeStatus['activity']): string {
  return JSON.stringify(activity)
}

function formatTimestamp(value: Nullable<number>): string {
  return isNotNull(value) ? new Date(value).toISOString() : 'unknown'
}

function describeRemoteNode(remoteNode: VelarHostRemoteNodeStatus): string {
  if (!remoteNode.enabled) return 'Remote node: disabled'
  const address = remoteNode.address ?? 'starting'
  const pairing = isNotNull(remoteNode.paired)
    ? `${remoteNode.paired.clientName}${remoteNode.connected ? ' (connected)' : ''}`
    : 'unpaired'
  return `Remote node: ${address} · ${pairing}`
}

function isManagementStatusPayload(value: unknown): value is ManagementStatusPayload {
  return isPlainObject(value)
    && isVelarHostPublicStatus(Reflect.get(value, 'host'))
    && isPlainObject(Reflect.get(value, 'config'))
}

function isVelarHostPublicStatus(value: unknown): value is VelarHostPublicStatus {
  if (!isPlainObject(value)) return false
  const management = Reflect.get(value, 'management')
  return Reflect.get(value, 'schemaVersion') === 3
    && Number.isInteger(Reflect.get(value, 'pid'))
    && isPlainObject(management)
    && (Reflect.get(management, 'kind') === 'unix' || Reflect.get(management, 'kind') === 'pipe')
    && isString(Reflect.get(management, 'endpoint'))
    && isPlainObject(Reflect.get(value, 'remoteNode'))
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
