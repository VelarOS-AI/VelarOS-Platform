import { AppError } from '@velaros-ai/core'
import { stringifyPretty } from '@velaros-ai/core/utils/json'

import {
  VelarosCliError,
  type VelarosCliErrorEnvelope,
  type VelarosCliRunResult,
  VelarosCliSchemaVersion,
  type VelarosCliSuccessEnvelope,
} from './types.js'

export interface FormatVelarosCliSuccessInput {
  namespace: string
  command: string
  cwd: string
  durationMs: number
  result: unknown
  json: boolean
  text?: string
  /** 命令执行成功但探针结果为 false 时允许返回非零，例如产品注入的 `status` 探针。 */
  exitCode?: number
}

export function formatVelarosCliSuccess(
  input: FormatVelarosCliSuccessInput,
): VelarosCliRunResult {
  const envelope: VelarosCliSuccessEnvelope = {
    schemaVersion: VelarosCliSchemaVersion,
    kind: `velaros.cli.${input.namespace}.${input.command}`,
    status: 'ok',
    namespace: input.namespace,
    command: input.command,
    cwd: input.cwd,
    durationMs: input.durationMs,
    result: input.result,
  }

  return {
    envelope,
    text: input.json
      ? `${stringifyPretty(envelope)}\n`
      : ensureTrailingNewline(input.text ?? stringifyPretty(input.result)),
    exitCode: input.exitCode ?? 0,
  }
}

export function normalizeVelarosCliError(error: unknown): VelarosCliError {
  if (error instanceof VelarosCliError) return error
  return new VelarosCliError('EXECUTION_ERROR', AppError.getMessage(error), 1)
}

export function formatVelarosCliError(
  error: unknown,
  json: boolean,
): VelarosCliRunResult {
  const normalized = normalizeVelarosCliError(error)
  const envelope: VelarosCliErrorEnvelope = {
    schemaVersion: VelarosCliSchemaVersion,
    kind: 'velaros.cli.error',
    status: 'error',
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    },
  }

  return {
    envelope,
    text: json
      ? `${stringifyPretty(envelope)}\n`
      : `${normalized.code}: ${normalized.message}\n`,
    exitCode: normalized.exitCode,
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}
