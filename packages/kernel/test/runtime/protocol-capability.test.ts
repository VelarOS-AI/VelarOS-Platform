import { describe, expect, test } from 'bun:test'

import {
  CapabilityCallRequestSchema,
  CapabilitySessionOpenRequestSchema,
  KernelHandshakeSchema,
  KernelProtocolVersion,
} from '../../src/contracts/protocol'

const workspaceModule = {
  id: 'velaros.workspace',
  version: '1.0.0',
  apiVersion: 1,
  provides: [{ id: 'velaros.workspace', version: '1.0.0' }],
  requires: [],
  optionalRequires: [{ id: 'velaros.model', versionRange: '^1.0.0' }],
  permissions: ['filesystem.read', 'filesystem.write'],
  isolation: 'worker',
  catalogRevision: 'workspace-catalog-v1',
} as const

describe('kernel capability protocol', () => {
  test('describes injected modules without product-space enums', () => {
    const handshake = KernelHandshakeSchema.parse({
      protocolVersion: KernelProtocolVersion,
      kernelVersion: '0.2.0',
      modules: [workspaceModule],
    })

    expect(handshake.modules[0]?.id).toBe('velaros.workspace')
    expect(handshake.modules[0]?.provides[0]?.id).toBe('velaros.workspace')
  })

  test('routes an opaque capability call through an opaque scope', () => {
    const request = CapabilityCallRequestSchema.parse({
      protocolVersion: KernelProtocolVersion,
      callId: 'call-1',
      sessionId: 'cap-session-1',
      capabilityId: 'velaros.workspace',
      operation: 'read',
      scope: {
        id: 'scope-1',
        ownerModuleId: 'velaros.workspace',
        kind: 'project',
      },
      input: { resourceId: 'file-1' },
    })

    expect(request.scope?.id).toBe('scope-1')
    expect(request.sessionId).toBe('cap-session-1')
    expect(request.input).toEqual({ resourceId: 'file-1' })
  })

  test('rejects undeclared module descriptor fields', () => {
    const parsed = KernelHandshakeSchema.safeParse({
      protocolVersion: KernelProtocolVersion,
      kernelVersion: '0.2.0',
      modules: [{ ...workspaceModule, workspaceRoot: '/private/project' }],
    })

    expect(parsed.success).toBe(false)
  })

  test('describes capability session open requires', () => {
    const request = CapabilitySessionOpenRequestSchema.parse({
      protocolVersion: KernelProtocolVersion,
      requires: [
        {
          capabilityId: 'velaros.workspace',
          operations: ['read'],
          scope: null,
        },
      ],
    })

    expect(request.requires[0]?.operations).toEqual(['read'])
  })
})
