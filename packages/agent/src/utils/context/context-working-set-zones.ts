export type ContextWorkingSetZoneId =
  | 'kernel'
  | 'tool-schemas'
  | 'active-task'
  | 'pinned-evidence'
  | 'recent-turns'
  | 'semantic-summary'
  | 'retrieval-index'
  | 'recall'
  | 'tool-payloads'
  | 'diagnostics'

export const ContextWorkingSetZoneIds: readonly ContextWorkingSetZoneId[] = [
  'kernel',
  'tool-schemas',
  'active-task',
  'pinned-evidence',
  'recent-turns',
  'semantic-summary',
  'retrieval-index',
  'recall',
  'tool-payloads',
  'diagnostics',
]

export type ContextWorkingSetReclaimAction =
  | 'keep'
  | 'summarize'
  | 'reference'
  | 'evict'
  | 'page-out'

export interface ContextWorkingSetZonePolicy {
  zone: ContextWorkingSetZoneId
  reservedRatio: number
  limitRatio: number
  priority: number
  reclaimOrder: ContextWorkingSetReclaimAction[]
}

export const DefaultContextWorkingSetZonePolicies: Record<
  ContextWorkingSetZoneId,
  ContextWorkingSetZonePolicy
> = {
  kernel: {
    zone: 'kernel',
    reservedRatio: 0.06,
    limitRatio: 0.18,
    priority: 100,
    reclaimOrder: ['keep'],
  },
  'tool-schemas': {
    zone: 'tool-schemas',
    reservedRatio: 0.04,
    limitRatio: 0.24,
    priority: 70,
    reclaimOrder: ['page-out'],
  },
  'active-task': {
    zone: 'active-task',
    reservedRatio: 0.08,
    limitRatio: 0.18,
    priority: 95,
    reclaimOrder: ['keep'],
  },
  'pinned-evidence': {
    zone: 'pinned-evidence',
    reservedRatio: 0.04,
    limitRatio: 0.14,
    priority: 90,
    reclaimOrder: ['reference', 'summarize'],
  },
  'recent-turns': {
    zone: 'recent-turns',
    reservedRatio: 0.14,
    limitRatio: 0.32,
    priority: 85,
    reclaimOrder: ['reference', 'summarize'],
  },
  'semantic-summary': {
    zone: 'semantic-summary',
    reservedRatio: 0.03,
    limitRatio: 0.12,
    priority: 80,
    reclaimOrder: ['summarize'],
  },
  'retrieval-index': {
    zone: 'retrieval-index',
    reservedRatio: 0.02,
    limitRatio: 0.08,
    priority: 65,
    reclaimOrder: ['evict'],
  },
  recall: {
    zone: 'recall',
    reservedRatio: 0,
    limitRatio: 0.14,
    priority: 30,
    reclaimOrder: ['evict', 'summarize'],
  },
  'tool-payloads': {
    zone: 'tool-payloads',
    reservedRatio: 0.02,
    limitRatio: 0.18,
    priority: 60,
    reclaimOrder: ['reference'],
  },
  diagnostics: {
    zone: 'diagnostics',
    reservedRatio: 0,
    limitRatio: 0.04,
    priority: 10,
    reclaimOrder: ['evict'],
  },
}
