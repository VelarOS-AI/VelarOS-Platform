import type { ToolCapabilitySchema } from '@velaros-ai/core/types'

export type ComputerToolCapabilitySchema = ToolCapabilitySchema & {
  metadata: Readonly<Record<string, unknown>>
}

/**
 * Read-tier desktop capability: screenshots and screen geometry. No actuation,
 * so it is concurrency-safe and lower risk than the control capability.
 */
export const ComputerObserveCapability = {
  effectKind: 'read',
  readScopes: ['system'],
  canReadArbitrarySource: true,
  concurrency: 'safe',
  reason: 'desktop screen observation',
} satisfies ToolCapabilitySchema

/**
 * High-risk actuation capability: mouse/keyboard control over arbitrary apps.
 * Every tool using this routes through the confirmation flow.
 */
export const ComputerControlCapability = {
  effectKind: 'execute',
  readScopes: ['system'],
  writeScopes: ['system'],
  process: { execution: 'dangerous' },
  canReadArbitrarySource: true,
  concurrency: 'unsafe',
  metadata: {
    canMutateWorkspace: false,
  },
  reason: 'desktop input control (mouse/keyboard)',
} satisfies ComputerToolCapabilitySchema
