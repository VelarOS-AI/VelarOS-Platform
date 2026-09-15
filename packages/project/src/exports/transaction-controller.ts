import { isString } from '@velaros-ai/core'

import type { ProjectTransactionController } from '../contract/provides.js'
import type { ProjectKernel } from '../impl/kernel/LocalProjectKernel.js'
import type {
  ProjectChangeListener,
  ProjectChangeListOptions,
  ProjectChangeRecord,
} from '../impl/persistence/change-feed.js'
import type { ApplyResult, RollbackResult } from '../types/edit.js'
import type { ProjectTransactionInput } from '../types/transaction.js'
import { ProjectError } from '../utils/errors.js'

const MaximumTransactionIdBytes = 512

function transactionId(input: ProjectTransactionInput): string {
  if (!isString(input?.transactionId)
    || new TextEncoder().encode(input.transactionId).byteLength > MaximumTransactionIdBytes) {
    throw new ProjectError('INVALID_INPUT', 'transactionId 必须是非空且有界的字符串。')
  }
  const normalized = input.transactionId.trim()
  if (!normalized) throw new ProjectError('INVALID_INPUT', 'transactionId 不能为空。')
  return normalized
}

/** Bind the finite consumer surface to the same kernel instance used by producers. */
export function createProjectTransactionController(
  project: Pick<ProjectKernel, 'applyEdit' | 'changeFeed' | 'rollback'>,
): ProjectTransactionController {
  return Object.freeze({
    list(options?: ProjectChangeListOptions): readonly ProjectChangeRecord[] {
      return project.changeFeed.list(options)
    },
    get(idValue: string): ProjectChangeRecord | undefined {
      return project.changeFeed.get(transactionId({ transactionId: idValue }))
    },
    subscribe(listener: ProjectChangeListener): () => void {
      return project.changeFeed.subscribe(listener)
    },
    apply(input: ProjectTransactionInput): Promise<ApplyResult> {
      return project.applyEdit({ transactionId: transactionId(input) })
    },
    rollback(input: ProjectTransactionInput): Promise<RollbackResult> {
      return project.rollback({ transactionId: transactionId(input) })
    },
  })
}
