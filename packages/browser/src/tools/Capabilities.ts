import type { ToolCapabilitySchema } from '@velaros-ai/agent/protocol'

export type BrowserCapabilityAccess = 'observe' | 'control' | 'artifact'

export type BrowserCapabilityMetadata = Readonly<{
  browserAccess: BrowserCapabilityAccess
  canMutateProject?: boolean
}> & Readonly<Record<string, unknown>>

export type BrowserToolCapabilitySchema = Omit<ToolCapabilitySchema, 'metadata'> & {
  metadata: BrowserCapabilityMetadata
}

export const BrowserObserveCapability = {
  effectKind: 'read',
  readScopes: ['browser'],
  canReadArbitrarySource: true,
  concurrency: 'safe',
  metadata: {
    browserAccess: 'observe',
  },
  reason: 'browser page observation',
} satisfies BrowserToolCapabilitySchema

/** 只读等待会占用同一页面事件通道，不能与其它等待并发。 */
export const BrowserWaitCapability = {
  ...BrowserObserveCapability,
  concurrency: 'unsafe',
  reason: 'browser pending event wait',
} satisfies BrowserToolCapabilitySchema

export const BrowserControlCapability = {
  effectKind: 'external',
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
  effectKind: 'read',
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
  effectKind: 'write',
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
  effectKind: 'external',
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
