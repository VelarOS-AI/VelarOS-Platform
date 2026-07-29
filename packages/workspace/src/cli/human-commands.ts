import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isArray, isFiniteNumber, isNonBlankString, isString,isUndefined, optionalWhen, stringifyPretty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { Workspace } from '../core/workspace.js'
import type { PrepareEditInput } from '../types/edit.js'
import type { ReadInput } from '../types/io.js'
import type { Postcondition } from '../types/validation.js'

import { type WorkspaceCliCommand, WorkspaceCliError, type WorkspaceCliRequest } from './types.js'

export interface RunHumanWorkspaceCommandInput {
  request: WorkspaceCliRequest
  workspace: Workspace
  cwd: string
}

export interface HumanWorkspaceCommandResult {
  kind: string
  result: any
  text: string
  exitCode?: number
}

interface CommitEditInput extends PrepareEditInput {
  autoApply?: boolean
  checks?: string[]
  postconditions?: Postcondition[]
}

const HelpText = `Velaros Workspace CLI

Commands:
  help
  status
  journal
  read <path> [--start <line>] [--end <line>] [--max-bytes <bytes>]
  search <query> [--regex]
  symbols <path>
  resolve <path> --exact <snippet>
  resolve <path> --symbol <name> [--kind <kind>]
  prepare-edit --input <file>
  commit-edit --input <file>
  apply <transactionId>
  validate [--transaction-id <id>] [--paths <a,b>]
  diff <transactionId>
  rollback <transactionId>
`

export async function runHumanWorkspaceCommand(
  input: RunHumanWorkspaceCommandInput
): Promise<HumanWorkspaceCommandResult> {
  const { request, workspace, cwd } = input

  switch (request.command) {
    case 'help':
      return commandResult(request.command, { commands: humanCommands() }, HelpText)
    case 'status':
      return jsonCommandResult(request.command, await workspace.status())
    case 'journal':
      return jsonCommandResult(request.command, workspace.getJournal())
    case 'read':
      return runRead(request, workspace)
    case 'search':
      return jsonCommandResult(request.command, await workspace.search({
        query: requiredString(request.args.query, 'search requires <query>.'),
        regex: Boolean(request.args.regex),
      }))
    case 'symbols':
      return jsonCommandResult(
        request.command,
        await workspace.listSymbols(requiredString(request.args.path, 'symbols requires <path>.'))
      )
    case 'resolve':
      return runResolve(request, workspace)
    case 'prepare-edit':
      return runPrepareEdit(request, workspace, cwd)
    case 'commit-edit':
      return runCommitEdit(request, workspace, cwd)
    case 'apply':
      return jsonCommandResult(request.command, await workspace.applyEdit({
        transactionId: requiredString(request.args.transactionId, 'apply requires <transactionId>.'),
      }))
    case 'validate':
      return jsonCommandResult(request.command, await workspace.validate({
        transactionId: optionalWhen(isNonBlankString, request.args.transactionId),
        paths: optionalStringArray(request.args.paths),
      }))
    case 'diff':
      return jsonCommandResult(request.command, await workspace.diff({
        transactionId: requiredString(request.args.transactionId, 'diff requires <transactionId>.'),
      }))
    case 'rollback':
      return jsonCommandResult(request.command, await workspace.rollback({
        transactionId: requiredString(request.args.transactionId, 'rollback requires <transactionId>.'),
      }))
    default:
      throw new WorkspaceCliError('UNKNOWN_COMMAND', `Unknown command: ${request.command}`, 2, {
        command: request.command,
      })
  }
}

async function runRead(
  request: WorkspaceCliRequest,
  workspace: Workspace
): Promise<HumanWorkspaceCommandResult> {
  const startLine = optionalNumber(request.args.startLine)
  const endLine = optionalNumber(request.args.endLine)
  const readInput: ReadInput = {
    path: requiredString(request.args.path, 'read requires <path>.'),
    maxBytes: optionalNumber(request.args.maxBytes),
  }
  if (!isUndefined(startLine) || !isUndefined(endLine)) {
    readInput.range = { startLine, endLine }
  }

  const result = await workspace.read(readInput)
  return commandResult(request.command, result, result.content ?? '')
}

async function runResolve(
  request: WorkspaceCliRequest,
  workspace: Workspace
): Promise<HumanWorkspaceCommandResult> {
  const exact = optionalWhen(isNonBlankString, request.args.exact)
  const symbol = optionalWhen(isNonBlankString, request.args.symbol)
  if (!exact && !symbol) {
    throw new WorkspaceCliError('ARGUMENT_ERROR', 'resolve requires --exact or --symbol.', 2)
  }

  const result = await workspace.resolveTarget({
    path: requiredString(request.args.path, 'resolve requires <path>.'),
    target: exact
      ? { exactSnippet: exact }
      : {
          symbol: {
            name: symbol!,
            kind: optionalWhen(isNonBlankString, request.args.kind),
          },
        },
  })
  return jsonCommandResult(request.command, result)
}

async function runPrepareEdit(
  request: WorkspaceCliRequest,
  workspace: Workspace,
  cwd: string
): Promise<HumanWorkspaceCommandResult> {
  const input = await readJsonFile<PrepareEditInput>(cwd, optionalWhen(isNonBlankString, request.args.input))
  return jsonCommandResult(request.command, await workspace.prepareEdit(input))
}

async function runCommitEdit(
  request: WorkspaceCliRequest,
  workspace: Workspace,
  cwd: string
): Promise<HumanWorkspaceCommandResult> {
  const { autoApply = true, checks, postconditions, ...prepareInput } =
    await readJsonFile<CommitEditInput>(cwd, optionalWhen(isNonBlankString, request.args.input))
  const transaction = await workspace.prepareEdit(prepareInput)
  const validation = await workspace.validate({
    transactionId: transaction.transactionId,
    checks,
    postconditions,
  })
  const baseResult = {
    changed: false,
    applied: false,
    transaction,
    validation,
  }

  if (!validation.ok) return jsonCommandResult(request.command, {
      ...baseResult,
      status: 'validation_failed',
    })

  if (!autoApply) return jsonCommandResult(request.command, {
      ...baseResult,
      status: 'validated',
    })

  const apply = await workspace.applyEdit({ transactionId: transaction.transactionId })
  return jsonCommandResult(request.command, {
    ...baseResult,
    status: 'applied',
    changed: true,
    applied: true,
    apply,
  })
}

async function readJsonFile<T>(cwd: string, filePath: string | undefined): Promise<T> {
  if (!filePath) {
    throw new WorkspaceCliError('ARGUMENT_ERROR', '--input is required.', 2)
  }

  let text: string
  try {
    text = await readFile(resolve(cwd, filePath), 'utf8')
  } catch (error) {
    const message = AppError.getMessage(error)
    throw new WorkspaceCliError('INPUT_FILE_ERROR', `Unable to read input file ${filePath}: ${message}`, 2, {
      path: filePath,
      message,
    })
  }

  try {
    return JSON.parse(text) as T
  } catch (error) {
    const message = AppError.getMessage(error)
    throw new WorkspaceCliError('INVALID_JSON', `Invalid JSON in ${filePath}: ${message}`, 2, {
      message,
    })
  }
}

function commandResult(
  command: WorkspaceCliCommand,
  result: any,
  text: string,
  exitCode?: number
): HumanWorkspaceCommandResult {
  return {
    kind: `velaros.workspaceCli.${command}`,
    result,
    text: text.endsWith('\n') ? text : `${text}\n`,
    exitCode,
  }
}

function jsonCommandResult(command: WorkspaceCliCommand, result: any): HumanWorkspaceCommandResult {
  return commandResult(command, result, `${stringifyPretty(result)}\n`)
}

function humanCommands(): WorkspaceCliCommand[] {
  return [
    'help',
    'status',
    'journal',
    'read',
    'search',
    'symbols',
    'resolve',
    'prepare-edit',
    'commit-edit',
    'apply',
    'validate',
    'diff',
    'rollback',
  ]
}

function requiredString(value: any, message: string): string {
  if (isNonBlankString(value)) return value
  throw new WorkspaceCliError('ARGUMENT_ERROR', message, 2)
}

function optionalNumber(value: any): number | undefined {
  return optionalWhen(isFiniteNumber, value)
}

function optionalStringArray(value: any): string[] | undefined {
  return optionalWhen((isArray(value) && value.every(isString)), value)
}
