export const MemoryReadCapability = {
  effectKind: 'read',
  readScopes: ['memory'],
  memoryAccess: 'read',
  concurrency: 'safe',
  reason: 'memory read',
} as const

export const MemoryWriteCapability = {
  effectKind: 'write',
  readScopes: ['memory'],
  writeScopes: ['memory'],
  memoryAccess: 'write',
  concurrency: 'unsafe',
  reason: 'memory write',
} as const
