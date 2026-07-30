import { AppError,isPlainObject, isRecord, isString, isUndefined, stringifyPretty } from '@velaros-ai/core'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import { WorkspaceError } from '../errors.js'

import {
  WorkspaceCliError,
  type WorkspaceCliErrorEnvelope,
  type WorkspaceCliRunResult,
  WorkspaceCliSchemaVersion,
  type WorkspaceCliSuccessEnvelope,
} from './types.js'

export interface FormatWorkspaceCliSuccessInput {
  kind: string
  workspaceRoot: string
  durationMs: number
  result: any
  json: boolean
  text: string
  exitCode?: number
}

export function formatWorkspaceCliSuccess(
  input: FormatWorkspaceCliSuccessInput
): WorkspaceCliRunResult {
  const envelope: WorkspaceCliSuccessEnvelope = {
    schemaVersion: WorkspaceCliSchemaVersion,
    kind: input.kind,
    status: 'ok',
    workspaceRoot: input.workspaceRoot,
    durationMs: input.durationMs,
    result: input.result,
  }
  return {
    envelope,
    text: input.json ? `${stringifyPretty(envelope)}\n` : input.text,
    exitCode: input.exitCode ?? 0,
  }
}

export function normalizeWorkspaceCliError(error: any): WorkspaceCliError {
  if (error instanceof WorkspaceCliError) return error
  const workspaceError = asWorkspaceDomainError(error)
  if (workspaceError) return new WorkspaceCliError(workspaceError.reason, workspaceError.message, 1, workspaceErrorDetails(workspaceError))
  return new WorkspaceCliError('EXECUTION_ERROR', AppError.getMessage(error), 1)
}

interface WorkspaceDomainErrorLike {
  reason: string
  message: string
  details: Record<string, any>
  suggestedNextAction?: string
}

function asWorkspaceDomainError(error: any): Nullable<WorkspaceDomainErrorLike> {
  if (error instanceof WorkspaceError) return {
      reason: error.reason,
      message: error.message,
      details: recordDetails(error.details),
      suggestedNextAction: error.suggestedNextAction,
    }
  if (!isErrorLikeWithReason(error)) return null
  return {
    reason: error.reason,
    message: error.message,
    details: recordDetails(error.details),
    suggestedNextAction:
      optionalWhen(isString, error.suggestedNextAction),
  }
}

function isErrorLikeWithReason(value: any): value is {
  reason: string
  message: string
  details?: any
  suggestedNextAction?: any
} {
  const record = isRecord(value) ? value : null
  return (
    !!record &&
    isString(record.reason) &&
    isString(record.message)
  )
}

function recordDetails(details: any): Record<string, any> {
  if (isPlainObject(details)) return { ...details }
  return isUndefined(details) ? {} : { details }
}

function workspaceErrorDetails(error: WorkspaceDomainErrorLike): Record<string, any> {
  const details = { ...error.details }
  if (!isUndefined(error.suggestedNextAction)) {
    details.suggestedNextAction = error.suggestedNextAction
  }
  return details
}

export function formatWorkspaceCliError(error: any, json: boolean): WorkspaceCliRunResult {
  const normalized = normalizeWorkspaceCliError(error)
  const envelope: WorkspaceCliErrorEnvelope = {
    schemaVersion: WorkspaceCliSchemaVersion,
    kind: 'velaros.workspaceCli.error',
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
