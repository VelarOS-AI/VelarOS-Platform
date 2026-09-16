/**
 * 代理面线格式的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 只经根入口，只测对外承诺的行为；schema 本身不出包，也就不单独测。
 */

import { describe, expect, test } from 'bun:test'

import {
  ProviderSurfaceLimits,
  ProviderSurfaceProtocol,
  providerSurfaceWire,
} from '../src/exports/index'

describe('线格式严格校验', () => {
  test('INV-1 目录用 revision，未声明的字段一律拒，失败只给路径与错误码', () => {
    const catalog = providerSurfaceWire.checkToolCatalog({
      protocolVersion: ProviderSurfaceProtocol.version,
      revision: 'workspace-readonly-v1',
      tools: [],
    })

    expect(catalog.ok).toBe(true)
    if (catalog.ok) {
      expect(catalog.value.revision).toBe('workspace-readonly-v1')
      expect('catalogRevision' in catalog.value).toBe(false)
    }

    const call = providerSurfaceWire.checkToolCall({
      protocolVersion: ProviderSurfaceProtocol.version,
      contractId: 'contract-1',
      catalogRevision: 'workspace-readonly-v1',
      toolCallId: 'call-1',
      toolName: 'project:read',
      input: { path: 'README.md' },
      bypassPermissionBroker: true,
    })

    expect(call.ok).toBe(false)
    if (!call.ok) {
      expect(call.issues.length).toBeGreaterThan(0)
      // 问题列表只带路径与错误码：载荷值一个字都不许带出来
      for (const issue of call.issues) expect(Object.keys(issue).sort()).toEqual(['code', 'path'])
      expect(JSON.stringify(call.issues)).not.toContain('README.md')
    }

    const workspaces = providerSurfaceWire.checkWorkspaceCatalog({
      revision: 'workspace-catalog-v1',
      workspaces: [{
        id: 'project',
        space: 'project',
        label: '项目',
        description: null,
        localPath: '/secret/path',
      }],
    })

    expect(workspaces.ok).toBe(false)
  })

  test('INV-2 附件有界：类型、编码、条数按常量表卡', () => {
    const base = {
      protocolVersion: ProviderSurfaceProtocol.version,
      contractId: 'contract-1',
      catalogRevision: 'catalog-1',
      toolCallId: 'call-1',
      toolName: 'computer:screenshot',
      status: 'success' as const,
      output: { width: 1280, height: 720 },
    }
    const artifact = {
      kind: 'image' as const,
      mediaType: 'image/jpeg' as const,
      data: 'aW1hZ2U=',
      name: 'desktop-screenshot.jpg',
    }

    const result = providerSurfaceWire.checkToolResult({ ...base, artifacts: [artifact] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.artifacts?.[0].mediaType).toBe('image/jpeg')

    expect(providerSurfaceWire.checkToolResult({
      ...base,
      artifacts: [{ ...artifact, data: 'not-base64' }],
    }).ok).toBe(false)
    expect(providerSurfaceWire.checkToolResult({
      ...base,
      artifacts: [{ ...artifact, name: 'x'.repeat(ProviderSurfaceLimits.artifactNameChars + 1) }],
    }).ok).toBe(false)
    expect(providerSurfaceWire.checkToolResult({
      ...base,
      artifacts: Array.from({ length: ProviderSurfaceLimits.artifactsPerResult + 1 }, () => artifact),
    }).ok).toBe(false)
  })

  test('INV-3 调用回显 catalogRevision，目录自己用 revision', () => {
    const call = providerSurfaceWire.checkToolCall({
      protocolVersion: ProviderSurfaceProtocol.version,
      contractId: 'contract-1',
      catalogRevision: 'workspace-readonly-v1',
      toolCallId: 'call-1',
      toolName: 'project:read',
      input: { path: 'README.md' },
    })

    expect(call.ok).toBe(true)
    if (call.ok) expect(call.value.catalogRevision).toBe('workspace-readonly-v1')
  })

  test('INV-4 协议版本冻结为 1，对不上就拒收', () => {
    expect(ProviderSurfaceProtocol.version).toBe(1)
    expect(providerSurfaceWire.checkToolCatalog({
      protocolVersion: 2,
      revision: 'workspace-readonly-v1',
      tools: [],
    }).ok).toBe(false)
  })

  test('INV-5 工厂造出的绑定一定过得了 checkBinding，参数不合法当场拒绝', () => {
    const binding = providerSurfaceWire.createBinding('chatgpt', 'project', 42)

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
    expect(providerSurfaceWire.checkBinding(binding).ok).toBe(true)

    expect(() => providerSurfaceWire.createBinding('', 'project')).toThrow(/绑定参数不合法：provider/u)
    expect(() => providerSurfaceWire.createBinding('chatgpt', 'project', 1.5))
      .toThrow(/绑定参数不合法/u)
  })
})
