export const MemoryReadCapability = {
  effectKind: 'memory',
  readScopes: ['memory'],
  memoryAccess: 'read',
  concurrency: 'safe',
  reason: 'memory read',
} as const

export const MemoryWriteCapability = {
  effectKind: 'memory',
  readScopes: ['memory'],
  writeScopes: ['memory'],
  memoryAccess: 'write',
  concurrency: 'unsafe',
  reason: 'memory write',
} as const
