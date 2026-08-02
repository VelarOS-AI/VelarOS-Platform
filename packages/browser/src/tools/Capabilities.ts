import type { ToolCapabilitySchema } from '@velaros-ai/core/types'

export type BrowserCapabilityAccess = 'observe' | 'control' | 'artifact'

export type BrowserCapabilityMetadata = Readonly<{
  browserAccess: BrowserCapabilityAccess
  canMutateProject?: boolean
}> & Readonly<Record<string, unknown>>

export type BrowserToolCapabilitySchema = Omit<ToolCapabilitySchema, 'metadata'> & {
  metadata: BrowserCapabilityMetadata
}

export const BrowserObserveCapability = {
  effectKind: 'browser',
  readScopes: ['browser'],
  canReadArbitrarySource: true,
  concurrency: 'safe',
  metadata: {
    browserAccess: 'observe',
  },
  reason: 'browser page observation',
} satisfies BrowserToolCapabilitySchema

export const BrowserControlCapability = {
  effectKind: 'browser',
  readScopes: ['browser'],
  writeScopes: ['browser'],
  canReadArbitrarySource: true,
  concurrency: 'unsafe',
  metadata: {
    browserAccess: 'control',
    canMutateProject: false,
  },
  reason: 'browser page control',
} satisfies BrowserToolCapabilitySchema

export const BrowserArtifactReadCapability = {
  effectKind: 'browser',
  readScopes: ['browser'],
  filesystem: { read: 'browser', write: 'none' },
  canReadArbitrarySource: false,
  concurrency: 'safe',
  metadata: {
    browserAccess: 'artifact',
  },
  reason: 'browser workspace artifact read',
} satisfies BrowserToolCapabilitySchema

export const BrowserArtifactWriteCapability = {
  effectKind: 'browser',
  readScopes: ['browser'],
  writeScopes: ['browser'],
  filesystem: { read: 'browser', write: 'browser' },
  canReadArbitrarySource: true,
  concurrency: 'unsafe',
  metadata: {
    browserAccess: 'artifact',
    canMutateProject: false,
  },
  reason: 'browser workspace artifact write',
} satisfies BrowserToolCapabilitySchema

export const BrowserSessionCapability = {
  effectKind: 'browser',
  readScopes: ['browser', 'system'],
  writeScopes: ['browser'],
  filesystem: { read: 'browser', write: 'browser' },
  canReadArbitrarySource: true,
  concurrency: 'unsafe',
  metadata: {
    browserAccess: 'control',
    canMutateProject: false,
  },
  reason: 'browser session management',
} satisfies BrowserToolCapabilitySchema
