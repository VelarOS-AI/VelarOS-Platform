import {
  isArray,
  isBlank,
  isBoolean,
  isEmpty,
  isNotUndefined,
  isNumber,
  isPlainObject,
  isPresent,
  isString,
  isUndefined,
} from '@velaros-ai/core'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
} from '@velaros-ai/kernel/contracts/abi'

import type {
  MemoryDomain,
  MemoryEvidenceCategory,
  MemoryEvidenceSourceType,
  MemoryRecallOptions,
} from '..'

export interface MemoryCapabilityService
  extends KernelCallableCapabilityService {}

export interface CreateMemoryKernelModuleOptions {
  /** Product-owned Memory domain; Kernel never opens its database directly. */
  readonly domain: Pick<
    MemoryDomain,
    'recall' | 'getClaim' | 'getDiagnostics' | 'verifyTreeIntegrity'
  >
}

export const MemoryCapability =
  createCapabilityToken<MemoryCapabilityService>('velaros.memory')

const memoryEvidenceCategories = new Set<MemoryEvidenceCategory>([
  'conversation',
  'fact',
  'preference',
  'feedback',
  'procedure',
  'project',
  'task',
  'goal',
  'interest',
  'entity',
  'artifact',
])

const memoryEvidenceSourceTypes = new Set<MemoryEvidenceSourceType>([
  'chat_message',
  'agent_tool',
  'execution_event',
  'workspace_event',
  'computer_use',
  'user_correction',
  'import',
])

function parseRecord(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new Error('Memory capability input is invalid')
  }
  return input
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error('Memory capability input is invalid')
  }
}

function parseIdentifierInput(input: unknown, key: string): string {
  const record = parseRecord(input)
  assertExactKeys(record, [key])
  const value = record[key]
  if (
    !isString(value)
    || isBlank(value.trim())
    || value !== value.trim()
    || value.length > 512
  ) {
    throw new Error('Memory capability input is invalid')
  }
  return value
}

function parseRecallInput(
  input: unknown,
  scopeId?: string,
): {
  query: string
  options: MemoryRecallOptions
} {
  const record = parseRecord(input)
  assertExactKeys(record, ['query', 'options'])
  if (
    !isString(record.query)
    || isBlank(record.query.trim())
    || record.query.length > 16_384
  ) {
    throw new Error('Memory capability input is invalid')
  }
  if (
    isNotUndefined(record.options)
    && !isPlainObject(record.options)
  ) {
    throw new Error('Memory capability input is invalid')
  }
  const rawOptions = isPlainObject(record.options) ? record.options : {}
  assertExactKeys(rawOptions, [
    'limit',
    'workspaceRoot',
    'scopeId',
    'includeGlobal',
    'excludeSessionId',
    'excludeAgentConversationEchoes',
    'excludeConversationObservations',
    'excludeSourceTypes',
    'categories',
    'includeDormant',
    'deep',
  ])
  if (
    isNotUndefined(rawOptions.limit)
    && (
      !isNumber(rawOptions.limit)
      || !Number.isInteger(rawOptions.limit)
      || rawOptions.limit < 1
      || rawOptions.limit > 100
    )
  ) {
    throw new Error('Memory capability input is invalid')
  }
  for (const key of ['workspaceRoot', 'scopeId', 'excludeSessionId']) {
    const value = rawOptions[key]
    if (
      isNotUndefined(value)
      && (
        !isString(value)
        || isEmpty(value)
        || value.length > 4096
      )
    ) {
      throw new Error('Memory capability input is invalid')
    }
  }
  for (const key of [
    'includeGlobal',
    'excludeAgentConversationEchoes',
    'excludeConversationObservations',
    'includeDormant',
    'deep',
  ]) {
    const value = rawOptions[key]
    if (isNotUndefined(value) && !isBoolean(value)) {
      throw new Error('Memory capability input is invalid')
    }
  }
  if (
    isNotUndefined(rawOptions.excludeSourceTypes)
    && (
      !isArray(rawOptions.excludeSourceTypes)
      || rawOptions.excludeSourceTypes.length > 16
      || rawOptions.excludeSourceTypes.some(
        (sourceType) =>
          !isString(sourceType)
          || !memoryEvidenceSourceTypes.has(sourceType as MemoryEvidenceSourceType)
      )
    )
  ) {
    throw new Error('Memory capability input is invalid')
  }
  if (
    isNotUndefined(rawOptions.categories)
    && (
      !isArray(rawOptions.categories)
      || rawOptions.categories.length > 32
      || rawOptions.categories.some(
        (category) =>
          !isString(category)
          || isEmpty(category)
          || category.length > 64
          || !memoryEvidenceCategories.has(
            category as MemoryEvidenceCategory,
          ),
      )
      || new Set(rawOptions.categories).size
        !== rawOptions.categories.length
    )
  ) {
    throw new Error('Memory capability input is invalid')
  }
  if (
    isNotUndefined(scopeId)
    && (
      isNotUndefined(rawOptions.workspaceRoot)
      || (
        isNotUndefined(rawOptions.scopeId)
        && rawOptions.scopeId !== scopeId
      )
    )
  ) {
    throw new Error('Memory capability input is invalid')
  }
  return {
    query: record.query.trim(),
    options: {
      ...rawOptions,
      ...(isUndefined(scopeId) ? {} : { scopeId }),
    } as MemoryRecallOptions,
  }
}

function parseEmptyInput(input: unknown): void {
  const record = parseRecord(input)
  assertExactKeys(record, [])
}

/**
 * Memory remains an independently owned capability. The initial wire surface
 * is deliberately read-only; capture, curation, and erasure stay unavailable
 * until their audit-safe command schemas are frozen.
 */
export function createMemoryKernelModule(
  options: CreateMemoryKernelModuleOptions,
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: 'velaros.memory.default',
      version: '0.3.0',
      apiVersion: KernelModuleApiVersion,
      provides: [MemoryCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['memory:read'],
      isolation: 'in-process',
    },
    activate(context) {
      const service = createKernelCallableCapability({
        recall: {
          metadata: {
            permissions: ['memory:read'],
            reason: 'Recall memory through the active product scope.',
          },
          invoke: (scope, input) => {
            const { query, options: recallOptions } = parseRecallInput(
              input,
              scope?.id,
            )
            return options.domain.recall(query, recallOptions)
          },
        },
        get_claim: {
          metadata: {
            permissions: ['memory:read'],
            reason: 'Read one memory claim by identity.',
          },
          async invoke(scope, input) {
            const claim = await options.domain.getClaim(
              parseIdentifierInput(input, 'claimId'),
            )
            if (
              isPresent(scope)
              && isPresent(claim)
              && claim.scopeType !== 'global'
              && claim.scopeId !== scope.id
            ) return null
            return claim
          },
        },
        diagnostics: {
          metadata: {
            permissions: ['memory:read'],
            reason: 'Inspect memory health diagnostics.',
          },
          invoke: (_scope, input) => {
            parseEmptyInput(input)
            return options.domain.getDiagnostics()
          },
        },
        verify_integrity: {
          metadata: {
            permissions: ['memory:read'],
            reason: 'Verify the current memory tree integrity.',
          },
          invoke: (_scope, input) => {
            parseEmptyInput(input)
            return options.domain.verifyTreeIntegrity()
          },
        },
      })
      context.registerService(MemoryCapability, service)
    },
  })
}
