import type { ToolCapabilitySchema } from '@velaros-ai/core/types'

export const GameManifestEditCapability = {
  effectKind: 'workspace-edit',
  readScopes: ['workspace', 'game-manifest'],
  writeScopes: ['workspace', 'game-manifest'],
  filesystem: { read: 'workspace', write: 'workspace' },
  concurrency: 'unsafe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'manifest-edit' },
  reason: 'semantic game manifest edit',
} satisfies ToolCapabilitySchema

export const GameRunCapability = {
  effectKind: 'process',
  readScopes: ['workspace', 'game-runtime'],
  writeScopes: ['game-runtime'],
  filesystem: { read: 'workspace', write: 'none' },
  process: { execution: 'long-running' },
  concurrency: 'unsafe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'runtime-control' },
  reason: 'approved game development server execution',
} satisfies ToolCapabilitySchema

export const GameObserveCapability = {
  effectKind: 'browser',
  readScopes: ['game-runtime'],
  concurrency: 'safe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'observe' },
  reason: 'game runtime observation',
} satisfies ToolCapabilitySchema

export const GameScreenshotCapability = {
  effectKind: 'browser',
  readScopes: ['game-runtime'],
  writeScopes: ['workspace'],
  filesystem: { read: 'none', write: 'workspace' },
  concurrency: 'unsafe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'artifact' },
  reason: 'game runtime screenshot artifact',
} satisfies ToolCapabilitySchema

export const GameInputCapability = {
  effectKind: 'browser',
  readScopes: ['game-runtime'],
  writeScopes: ['game-runtime'],
  concurrency: 'unsafe',
  canReadArbitrarySource: false,
  metadata: { gameAccess: 'control' },
  reason: 'game runtime input control',
} satisfies ToolCapabilitySchema
