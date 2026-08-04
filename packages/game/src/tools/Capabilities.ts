import type { ToolCapabilitySchema } from '@velaros-ai/agent/protocol'

export const GameManifestEditCapability = {
  effectKind: 'write',
  readScopes: ['project', 'game-manifest'],
  writeScopes: ['project', 'game-manifest'],
  filesystem: { read: 'project', write: 'project' },
  concurrency: 'unsafe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'manifest-edit' },
  reason: 'semantic game manifest edit',
} satisfies ToolCapabilitySchema

export const GameRunCapability = {
  effectKind: 'execute',
  readScopes: ['project', 'game-runtime'],
  writeScopes: ['game-runtime'],
  filesystem: { read: 'project', write: 'none' },
  process: { execution: 'long-running' },
  concurrency: 'unsafe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'runtime-control' },
  reason: 'approved game development server execution',
} satisfies ToolCapabilitySchema

export const GameObserveCapability = {
  effectKind: 'read',
  readScopes: ['game-runtime'],
  concurrency: 'safe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'observe' },
  reason: 'game runtime observation',
} satisfies ToolCapabilitySchema

export const GameScreenshotCapability = {
  effectKind: 'write',
  readScopes: ['game-runtime'],
  writeScopes: ['project'],
  filesystem: { read: 'none', write: 'project' },
  concurrency: 'unsafe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'artifact' },
  reason: 'game runtime screenshot artifact',
} satisfies ToolCapabilitySchema

export const GameInputCapability = {
  effectKind: 'external',
  readScopes: ['game-runtime'],
  writeScopes: ['game-runtime'],
  concurrency: 'unsafe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'control' },
  reason: 'game runtime input control',
} satisfies ToolCapabilitySchema
