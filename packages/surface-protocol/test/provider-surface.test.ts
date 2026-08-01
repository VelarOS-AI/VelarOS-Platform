import { describe, expect, test } from 'bun:test'

import {
  createProviderSurfaceBinding,
  ProviderSurfaceProtocolVersion,
  ProviderSurfaceToolCallSchema,
  ProviderSurfaceToolCatalogSchema,
  ProviderSurfaceToolResultSchema,
  ProviderSurfaceWorkspaceCatalogSchema,
} from '../src'

describe('provider surface protocol', () => {
  test('uses the deployed catalog revision field and a frozen protocol version', () => {
    const catalog = ProviderSurfaceToolCatalogSchema.parse({
      protocolVersion: ProviderSurfaceProtocolVersion,
      revision: 'workspace-readonly-v1',
      tools: [],
    })

    expect(ProviderSurfaceProtocolVersion).toBe(1)
    expect(catalog.revision).toBe('workspace-readonly-v1')
    expect('catalogRevision' in catalog).toBe(false)
  })

  test('rejects undeclared tool-call fields', () => {
    const result = ProviderSurfaceToolCallSchema.safeParse({
      protocolVersion: ProviderSurfaceProtocolVersion,
      contractId: 'contract-1',
      catalogRevision: 'workspace-readonly-v1',
      toolCallId: 'call-1',
      toolName: 'ws_read',
      input: { path: 'README.md' },
      bypassPermissionBroker: true,
    })

    expect(result.success).toBe(false)
  })

  test('creates a provider-owned binding and keeps workspace catalogs strict', () => {
    const binding = createProviderSurfaceBinding('chatgpt', 'project', 42)

    expect(binding).toEqual({
      provider: 'chatgpt',
      surfaceOwner: 'provider',
      workspaceSpace: 'project',
      providerConversationId: null,
      providerParentMessageId: null,
      selectedModelId: null,
      selectedReasoningEffort: null,
      capabilityValues: {},
      adapterRevision: null,
      toolContract: null,
      createdAt: 42,
      updatedAt: 42,
    })

    expect(ProviderSurfaceWorkspaceCatalogSchema.safeParse({
      revision: 'workspace-catalog-v1',
      workspaces: [{
        id: 'project',
        space: 'project',
        label: 'Project',
        description: null,
        localPath: '/secret/path',
      }],
    }).success).toBe(false)
  })

  test('carries bounded image artifacts outside textual tool output', () => {
    const result = ProviderSurfaceToolResultSchema.parse({
      protocolVersion: ProviderSurfaceProtocolVersion,
      contractId: 'contract-1',
      catalogRevision: 'catalog-1',
      toolCallId: 'call-1',
      toolName: 'computer_screenshot',
      status: 'success',
      output: { width: 1280, height: 720 },
      artifacts: [{
        kind: 'image',
        mediaType: 'image/jpeg',
        data: 'aW1hZ2U=',
        name: 'desktop-screenshot.jpg',
      }],
    })

    expect(result.artifacts?.[0].mediaType).toBe('image/jpeg')
    expect(ProviderSurfaceToolResultSchema.safeParse({
      ...result,
      artifacts: [{ ...result.artifacts?.[0], data: 'not-base64' }],
    }).success).toBe(false)
  })
})
