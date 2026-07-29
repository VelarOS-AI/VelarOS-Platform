import { isEmpty,isNull, isUndefined } from '@velaros-ai/core'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import { WorkspaceCliError, type WorkspaceCliRequest } from './types.js'

const JsonCommands = new Set(['tools'])
const ValuelessGlobalFlags = new Set(['--json'])
const ValuedGlobalFlags = new Set(['--cwd'])
const EmptyStringValueFlags = new Set(['--args-json', '--steps-json'])

export function inferWorkspaceCliJsonMode(argv: string[]): boolean {
  if (hasFlag(argv, '--json')) return true
  return JsonCommands.has(argv[findCommandStartForJsonMode(argv)] ?? '')
}

function findCommandStartForJsonMode(argv: string[]): number {
  let index = 0
  while (index < argv.length) {
    const value = argv[index]
    if (ValuelessGlobalFlags.has(value)) {
      index += 1
      continue
    }
    if (ValuedGlobalFlags.has(value)) {
      const next = argv[index + 1]
      if (isMissingFlagValue(value, next)) return index
      index += 2
      continue
    }
    return index
  }
  return index
}

function valueAfter(argv: string[], name: string): Nullable<string> {
  const index = argv.indexOf(name)
  if (index < 0) return null
  const value = argv[index + 1]
  if (isMissingFlagValue(name, value)) {
    throw new WorkspaceCliError('ARGUMENT_ERROR', `${name} requires a value.`, 2, { flag: name })
  }
  return value
}

function isMissingFlagValue(name: string, value: string | undefined): boolean {
  return isUndefined(value) || value.startsWith('--') || (isEmpty(value) && !EmptyStringValueFlags.has(name))
}

function normalizeGlobalFlags(argv: string[]): string[] {
  const globals: string[] = []
  const commandStart = findCommandStart(argv, globals)
  return [...argv.slice(commandStart), ...globals]
}

function findCommandStart(argv: string[], globals: string[]): number {
  let index = 0
  while (index < argv.length) {
    const value = argv[index]
    if (ValuelessGlobalFlags.has(value)) {
      globals.push(value)
      index += 1
      continue
    }

    if (ValuedGlobalFlags.has(value)) {
      const next = argv[index + 1]
      if (isMissingFlagValue(value, next)) {
        throw new WorkspaceCliError('ARGUMENT_ERROR', `${value} requires a value.`, 2, { flag: value })
      }
      globals.push(value, next)
      index += 2
      continue
    }

    return index
  }

  return index
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

function validateArgs(
  command: string,
  argv: string[],
  positionalIndexes: Set<number>,
  booleanFlags: Set<string>,
  valueFlags: Set<string>,
  detailsCommand = command
): void {
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]

    if (value.startsWith('--')) {
      if (!booleanFlags.has(value) && !valueFlags.has(value)) {
        throw new WorkspaceCliError('ARGUMENT_ERROR', `${command} received unknown flag: ${value}.`, 2, {
          command: detailsCommand,
          flag: value,
        })
      }
      if (valueFlags.has(value)) {
        const flagValue = argv[index + 1]
        if (isMissingFlagValue(value, flagValue)) {
          throw new WorkspaceCliError('ARGUMENT_ERROR', `${value} requires a value.`, 2, { flag: value })
        }
        index += 1
      }
      continue
    }

    if (positionalIndexes.has(index)) continue

    throw new WorkspaceCliError('ARGUMENT_ERROR', `${command} received unexpected argument: ${value}.`, 2, {
      command: detailsCommand,
      argument: value,
    })
  }
}

function numberFlag(argv: string[], name: string): number | undefined {
  const value = valueAfter(argv, name)
  if (isNull(value)) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new WorkspaceCliError('ARGUMENT_ERROR', `${name} must be a number.`, 2, {
      flag: name,
      value,
    })
  }
  return parsed
}

function stringFlag(argv: string[], name: string): Nullable<string> {
  return valueAfter(argv, name)
}

function splitCsv(value: Nullable<string>): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return optionalWhen((!isEmpty(items)), items)
}

function baseRequest(
  command: WorkspaceCliRequest['command'],
  argv: string[],
  args: Record<string, any>
): WorkspaceCliRequest {
  const explicitJson = hasFlag(argv, '--json')
  return {
    command,
    json: explicitJson || JsonCommands.has(argv[0] ?? ''),
    cwd: stringFlag(argv, '--cwd'),
    args,
  }
}

function requirePositional(argv: string[], index: number, message: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new WorkspaceCliError('ARGUMENT_ERROR', message, 2)
  }
  return value
}

export function parseWorkspaceCliArgs(argv: string[]): WorkspaceCliRequest {
  const normalizedArgv = normalizeGlobalFlags(argv)
  const command = normalizedArgv[0] ?? 'help'

  if (command === 'help' || command === '--help' || command === '-h') return baseRequest('help', normalizedArgv, {})

  if (command === 'status' || command === 'journal') {
    validateArgs(command, normalizedArgv, new Set(), new Set(['--json']), new Set(['--cwd']))
    return baseRequest(command, normalizedArgv, {})
  }

  if (command === 'read') {
    validateArgs('read', normalizedArgv, new Set([1]), new Set(['--json']), new Set(['--cwd', '--start', '--end', '--max-bytes']))
    return baseRequest('read', normalizedArgv, {
      path: requirePositional(normalizedArgv, 1, 'read requires <path>.'),
      startLine: numberFlag(normalizedArgv, '--start'),
      endLine: numberFlag(normalizedArgv, '--end'),
      maxBytes: numberFlag(normalizedArgv, '--max-bytes'),
    })
  }

  if (command === 'search') {
    validateArgs('search', normalizedArgv, new Set([1]), new Set(['--json', '--regex']), new Set(['--cwd']))
    return baseRequest('search', normalizedArgv, {
      query: requirePositional(normalizedArgv, 1, 'search requires <query>.'),
      regex: hasFlag(normalizedArgv, '--regex'),
    })
  }

  if (command === 'symbols') {
    validateArgs('symbols', normalizedArgv, new Set([1]), new Set(['--json']), new Set(['--cwd']))
    return baseRequest('symbols', normalizedArgv, {
      path: requirePositional(normalizedArgv, 1, 'symbols requires <path>.'),
    })
  }

  if (command === 'resolve') {
    validateArgs('resolve', normalizedArgv, new Set([1]), new Set(['--json']), new Set(['--cwd', '--exact', '--symbol', '--kind']))
    return baseRequest('resolve', normalizedArgv, {
      path: requirePositional(normalizedArgv, 1, 'resolve requires <path>.'),
      exact: stringFlag(normalizedArgv, '--exact'),
      symbol: stringFlag(normalizedArgv, '--symbol'),
      kind: stringFlag(normalizedArgv, '--kind'),
    })
  }

  if (command === 'prepare-edit' || command === 'commit-edit') {
    validateArgs(command, normalizedArgv, new Set(), new Set(['--json']), new Set(['--cwd', '--input']))
    return baseRequest(command, normalizedArgv, {
      input: stringFlag(normalizedArgv, '--input'),
    })
  }

  if (command === 'apply' || command === 'diff' || command === 'rollback') {
    validateArgs(command, normalizedArgv, new Set([1]), new Set(['--json']), new Set(['--cwd']))
    return baseRequest(command, normalizedArgv, {
      transactionId: requirePositional(normalizedArgv, 1, `${command} requires <transactionId>.`),
    })
  }

  if (command === 'validate') {
    validateArgs('validate', normalizedArgv, new Set(), new Set(['--json']), new Set(['--cwd', '--transaction-id', '--paths']))
    return baseRequest('validate', normalizedArgv, {
      transactionId: stringFlag(normalizedArgv, '--transaction-id'),
      paths: splitCsv(stringFlag(normalizedArgv, '--paths')),
    })
  }

  if (command === 'tools') {
    const action = normalizedArgv[1]
    if (action === 'list') {
      validateArgs('tools list', normalizedArgv, new Set([1]), new Set(['--json']), new Set(['--cwd']), 'tools.list')
      return baseRequest('tools.list', normalizedArgv, {})
    }
    if (action === 'call') {
      validateArgs(
        'tools call',
        normalizedArgv,
        new Set([1, 2]),
        new Set(['--json']),
        new Set(['--cwd', '--args-json', '--args-file']),
        'tools.call'
      )
      return baseRequest('tools.call', normalizedArgv, {
        toolName: requirePositional(normalizedArgv, 2, 'tools call requires <toolName>.'),
        argsJson: stringFlag(normalizedArgv, '--args-json'),
        argsFile: stringFlag(normalizedArgv, '--args-file'),
      })
    }
    if (action === 'workflow') {
      validateArgs(
        'tools workflow',
        normalizedArgv,
        new Set([1]),
        new Set(['--json']),
        new Set(['--cwd', '--steps-json', '--steps-file']),
        'tools.workflow'
      )
      return baseRequest('tools.workflow', normalizedArgv, {
        stepsJson: stringFlag(normalizedArgv, '--steps-json'),
        stepsFile: stringFlag(normalizedArgv, '--steps-file'),
      })
    }

    const nestedCommand = action ? `tools.${action}` : 'tools'
    throw new WorkspaceCliError('UNKNOWN_COMMAND', `Unknown command: ${nestedCommand}`, 2, {
      command: nestedCommand,
    })
  }

  throw new WorkspaceCliError('UNKNOWN_COMMAND', `Unknown command: ${command}`, 2, { command })
}
