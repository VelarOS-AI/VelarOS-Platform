export const KnowledgeReadCapability = {
  effectKind: 'memory',
  readScopes: ['memory', 'workspace'],
  memoryAccess: 'read',
  concurrency: 'safe',
  reason: 'knowledge index read',
} as const

export const KnowledgeWriteCapability = {
  effectKind: 'memory',
  readScopes: ['memory', 'workspace'],
  writeScopes: ['memory'],
  memoryAccess: 'write',
  concurrency: 'unsafe',
  reason: 'knowledge index write',
} as const
