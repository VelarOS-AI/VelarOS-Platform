import { describe, expect, test } from 'bun:test'

import { SessionToolAllocator } from '../src/agent/control-plane'
import {
  type AgentRuntimeCapabilityPorts,
  decideCapabilityScopeCategory,
  resolveCapabilityDelegationPolicy,
  resolveCapabilityPromptSegments,
  resolveCapabilityScopeId,
  resolveToolAllocationMetadata,
  resolveToolResultMiddlewares,
  resolveToolValidationHintProviders,
} from '../src/capabilities'
import { ToolArgsSchemaValidator } from '../src/tools'

describe('Agent Runtime capability injection', () => {
  const ports: AgentRuntimeCapabilityPorts = {
    delegationPolicy: {
      blockedToolNames: ['nested_dispatch'],
      blockedCategoryIds: ['privileged' as any],
    },
    scopePolicy: {
      resolveScopeId: (facts) => facts.scopeId ?? 'neutral',
      decideCategory: (categoryId, facts) => ({
        allowed: facts.satisfiedFactIds?.includes(`allow:${categoryId}`) ?? false,
      }),
    },
    extensions: [
      {
        descriptor: {
          id: 'example.documents',
          version: '1.0.0',
          toolNames: ['documents_read'],
          categoryIds: ['documents' as any],
          operationIds: ['read-document'],
        },
        resultMiddlewares: [
          {
            id: 'second',
            priority: 20,
            transform: ({ result }) => ({ result: `${String(result)}:second` }),
          },
          {
            id: 'first',
            priority: 10,
            transform: ({ result }) => ({ result: `${String(result)}:first` }),
          },
        ],
        validationHintProviders: [
          {
            id: 'document-validation',
            getRecovery: ({ toolName }) =>
              toolName === 'documents_read'
                ? {
                    hint: 'Provide a bounded document range. ',
                    nextActions: ['Pass a range supported by the current schema.'],
                  }
                : undefined,
          },
        ],
        promptContributors: [
          {
            id: 'document-prompt',
            getSegments: () => [
              {
                id: 'capability.documents',
                label: 'Documents',
                stability: 'dynamic',
                source: 'runtime',
                priority: 1000,
                render: () => 'Injected document guidance.',
              },
            ],
          },
        ],
        allocation: {
          baselineToolNames: ['capability_discovery'],
          operationCategories: {
            'read-document': ['documents' as any],
            'delegate-document': ['documents' as any],
          },
          delegatedOperations: {
            'delegate-document': {
              message: 'Delegate this operation through the host-owned route.',
            },
          },
          prerequisites: [
            {
              id: 'document-source-ready',
              categoryIds: ['documents' as any],
              message: 'A document source must be selected.',
            },
          ],
        },
      },
    ],
  }

  test('merges declarative extension metadata without built-in domain defaults', () => {
    expect(resolveToolAllocationMetadata(undefined)).toEqual({
      baselineToolNames: [],
      operationCategories: {},
      delegatedOperations: {},
      prerequisites: [],
    })
    expect(resolveToolAllocationMetadata(ports)).toMatchObject({
      baselineToolNames: ['capability_discovery'],
      operationCategories: {
        'read-document': ['documents'],
      },
    })
  })

  test('orders result middleware and prompt contributors deterministically', async () => {
    const middlewares = resolveToolResultMiddlewares(ports)
    let result: unknown = 'base'
    for (const middleware of middlewares) {
      result = (
        await middleware.transform({
          toolCallId: 'call-1',
          toolName: 'documents_read',
          args: {},
          result,
          executionContext: {},
        })
      )?.result
    }
    expect(result).toBe('base:first:second')
    expect(resolveCapabilityPromptSegments(ports, {}).map((segment) => segment.id)).toEqual([
      'capability.documents',
    ])
  })

  test('uses capability-owned validation guidance', () => {
    const validator = new ToolArgsSchemaValidator()
    const providers = resolveToolValidationHintProviders(ports)
    expect(
      validator.describeValidationHint('documents_read', 'range is required', providers)
    ).toBe('Provide a bounded document range. ')
    expect(
      validator.buildValidationNextActions(
        'documents_read',
        [{ path: 'range', message: 'Required' }],
        providers
      )[0]
    ).toBe('Pass a range supported by the current schema.')
  })

  test('enforces injected prerequisites and delegation metadata', async () => {
    const allocator = new SessionToolAllocator({ capabilityPorts: ports })
    const baseInput = {
      turn: 1,
      latestUserText: 'Read the selected source',
      runtimeToolCategories: [
        {
          category: { id: 'documents' as any },
          tools: [{ name: 'documents_read' }],
        },
      ],
      enabledToolCategoryIds: [] as any[],
      allowedToolCategoryIds: ['documents' as any],
    }

    const blocked = await allocator.plan({
      ...baseInput,
      requests: [
        {
          intent: 'read',
          operations: ['read-document'],
          reason: 'requested',
        },
      ],
    })
    expect(blocked.deniedRequests[0]).toMatchObject({
      code: 'prerequisite_missing',
      categoryId: 'documents',
    })

    const granted = await allocator.plan({
      ...baseInput,
      requests: [
        {
          intent: 'read',
          operations: ['read-document'],
          reason: 'requested',
        },
      ],
      satisfiedPrerequisiteIds: ['document-source-ready'],
    })
    expect(granted.grantedToolNames).toEqual(['documents_read'])

    const delegated = await allocator.plan({
      ...baseInput,
      requests: [
        {
          intent: 'delegate',
          operations: ['delegate-document'],
          reason: 'requested',
        },
      ],
      satisfiedPrerequisiteIds: ['document-source-ready'],
    })
    expect(delegated.deniedRequests[0]?.code).toBe('delegated')
  })

  test('keeps scope and delegation semantics product-owned', () => {
    expect(resolveCapabilityScopeId(ports, { scopeId: 'document-session' })).toBe(
      'document-session'
    )
    expect(
      decideCapabilityScopeCategory(ports, 'documents' as any, {
        satisfiedFactIds: ['allow:documents'],
      }).allowed
    ).toBe(true)
    expect(resolveCapabilityDelegationPolicy(ports)).toEqual({
      blockedToolNames: ['nested_dispatch'],
      blockedCategoryIds: ['privileged'],
    })
  })
})
