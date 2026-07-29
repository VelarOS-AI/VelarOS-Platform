import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
} from '@velaros-ai/core/kernel/abi'

import type {
  MemoryDomain,
  MemoryEvidenceCategory,
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

function parseRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Memory capability input is invalid')
  }
  return input as Record<string, unknown>
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
    typeof value !== 'string'
    || value.trim().length === 0
    || value !== value.trim()
    || value.length > 512
  ) {
    throw new Error('Memory capability input is invalid')
  }
  return value
}

function parseRecallInput(
  input: unknown,
  scopeId: string | undefined,
): {
  query: string
  options: MemoryRecallOptions
} {
  const record = parseRecord(input)
  assertExactKeys(record, ['query', 'options'])
  if (
    typeof record.query !== 'string'
    || record.query.trim().length === 0
    || record.query.length > 16_384
  ) {
    throw new Error('Memory capability input is invalid')
  }
  if (
    record.options !== undefined
    && (
      typeof record.options !== 'object'
      || record.options === null
      || Array.isArray(record.options)
    )
  ) {
    throw new Error('Memory capability input is invalid')
  }
  const rawOptions = (record.options ?? {}) as Record<string, unknown>
  assertExactKeys(rawOptions, [
    'limit',
    'workspaceRoot',
    'scopeId',
    'includeGlobal',
    'excludeSessionId',
    'excludeAgentConversationEchoes',
    'categories',
    'includeDormant',
    'deep',
  ])
  if (
    rawOptions.limit !== undefined
    && (
      typeof rawOptions.limit !== 'number'
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
      value !== undefined
      && (
        typeof value !== 'string'
        || value.length === 0
        || value.length > 4096
      )
    ) {
      throw new Error('Memory capability input is invalid')
    }
  }
  for (const key of [
    'includeGlobal',
    'excludeAgentConversationEchoes',
    'includeDormant',
    'deep',
  ]) {
    const value = rawOptions[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error('Memory capability input is invalid')
    }
  }
  if (
    rawOptions.categories !== undefined
    && (
      !Array.isArray(rawOptions.categories)
      || rawOptions.categories.length > 32
      || rawOptions.categories.some(
        (category) =>
          typeof category !== 'string'
          || category.length === 0
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
    scopeId !== undefined
    && (
      rawOptions.workspaceRoot !== undefined
      || (
        rawOptions.scopeId !== undefined
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
      ...(scopeId === undefined ? {} : { scopeId }),
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
      apiVersion: 1,
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
              scope !== undefined
              && claim !== null
              && claim.scopeType !== 'global'
              && claim.scopeId !== scope.id
            ) {
              return null
            }
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
