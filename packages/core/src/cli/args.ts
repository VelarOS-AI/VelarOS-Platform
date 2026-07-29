import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { AppError } from '../error.js'
import { isString, isUndefined } from '../typeGuards.js'
import { isEmpty } from '../utils/array.js'
import { toNullable } from '../utils/nullish.js'

import { VelarosCliError } from './types.js'

const ValuelessGlobalFlags = new Set(['--json'])
const ValuedGlobalFlags = new Set(['--cwd'])
const EmptyStringValueFlags = new Set(['--args-json', '--steps-json'])

export interface ParsedGlobalCliFlags {
  argv: string[]
  json: boolean
  cwd: Nullable<string>
}

export function inferVelarosCliJsonMode(argv: readonly string[], jsonDefault = false): boolean {
  return argv.includes('--json') || jsonDefault || argv[0] === 'tools'
}

export function parseVelarosCliGlobalFlags(
  argv: readonly string[],
  options: { jsonDefault?: boolean } = {}
): ParsedGlobalCliFlags {
  const normalized = normalizeGlobalFlags(argv)
  return {
    argv: normalized,
    json: inferVelarosCliJsonMode(normalized, options.jsonDefault),
    cwd: valueAfter(normalized, '--cwd'),
  }
}

export function validateCliArgs(input: {
  command: string
  argv: readonly string[]
  positionalIndexes: ReadonlySet<number>
  booleanFlags?: ReadonlySet<string>
  valueFlags?: ReadonlySet<string>
  detailsCommand?: string
}): void {
  const booleanFlags = input.booleanFlags ?? new Set<string>()
  const valueFlags = input.valueFlags ?? new Set<string>()
  const detailsCommand = input.detailsCommand ?? input.command

  for (let index = 1; index < input.argv.length; index += 1) {
    const value = input.argv[index]

    if (value.startsWith('--')) {
      if (!booleanFlags.has(value) && !valueFlags.has(value)) {
        throw new VelarosCliError(
          'ARGUMENT_ERROR',
          `${input.command} received unknown flag: ${value}.`,
          2,
          { command: detailsCommand, flag: value }
        )
      }
      if (valueFlags.has(value)) {
        const flagValue = input.argv[index + 1]
        if (isMissingFlagValue(value, flagValue)) {
          throw new VelarosCliError('ARGUMENT_ERROR', `${value} requires a value.`, 2, {
            flag: value,
          })
        }
        index += 1
      }
      continue
    }

    if (input.positionalIndexes.has(index)) continue

    throw new VelarosCliError(
      'ARGUMENT_ERROR',
      `${input.command} received unexpected argument: ${value}.`,
      2,
      { command: detailsCommand, argument: value }
    )
  }
}

export { valueAfter as stringFlag }

export async function readJsonPayload<T>(
  cwd: string,
  input: {
    inlineJson?: LooseOptional<string>
    filePath?: LooseOptional<string>
    defaultValue: T
    label?: string
  }
): Promise<T> {
  const filePath = toNullable(input.filePath)
  const inlineJson = toNullable(input.inlineJson)
  const hasInlineJson = isString(inlineJson)
  const hasFilePath = isString(filePath)

  if (hasInlineJson && hasFilePath) {
    throw new VelarosCliError('ARGUMENT_ERROR', 'Use inline JSON or file JSON, not both.', 2)
  }
  if (!hasInlineJson && !hasFilePath) return input.defaultValue

  let text = inlineJson ?? ''
  if (hasFilePath) {
    try {
      text = filePath === '-' ? readFileSync(0, 'utf8') : await readFile(resolve(cwd, filePath), 'utf8')
    } catch (error) {
      const message = AppError.getMessage(error)
      throw new VelarosCliError(
        'INPUT_FILE_ERROR',
        `Unable to read input file ${filePath}: ${message}`,
        2,
        { path: filePath, message }
      )
    }
  }

  try {
    return JSON.parse(text) as T
  } catch (error) {
    const message = AppError.getMessage(error)
    throw new VelarosCliError('INVALID_JSON', `Invalid JSON payload${input.label ? ` for ${input.label}` : ''}.`, 2, {
      message,
    })
  }
}

function normalizeGlobalFlags(argv: readonly string[]): string[] {
  const globals: string[] = []
  const commandStart = findCommandStart(argv, globals)
  return [...argv.slice(commandStart), ...globals]
}

function findCommandStart(argv: readonly string[], globals: string[]): number {
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
        throw new VelarosCliError('ARGUMENT_ERROR', `${value} requires a value.`, 2, {
          flag: value,
        })
      }
      globals.push(value, next)
      index += 2
      continue
    }

    return index
  }

  return index
}

function valueAfter(argv: readonly string[], name: string): Nullable<string> {
  const index = argv.indexOf(name)
  if (index < 0) return null
  const value = argv[index + 1]
  if (isMissingFlagValue(name, value)) {
    throw new VelarosCliError('ARGUMENT_ERROR', `${name} requires a value.`, 2, { flag: name })
  }
  return value
}

function isMissingFlagValue(name: string, value: string | undefined): boolean {
  return isUndefined(value) || value.startsWith('--') || (isEmpty(value) && !EmptyStringValueFlags.has(name))
}
