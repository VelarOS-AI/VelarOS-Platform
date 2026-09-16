export const KnowledgeReadCapability = {
  effectKind: 'read',
  readScopes: ['memory', 'workspace'],
  memoryAccess: 'read',
  concurrency: 'safe',
  reason: 'knowledge index read',
} as const

export const KnowledgeWriteCapability = {
  effectKind: 'write',
  readScopes: ['memory', 'workspace'],
  writeScopes: ['memory'],
  memoryAccess: 'write',
  concurrency: 'unsafe',
  reason: 'knowledge index write',
} as const
