import { isString } from '@velaros-ai/core'

import type { ProjectKernel } from './core/project-kernel.js'
import type { ApplyResult, RollbackResult } from './types/edit.js'
import type {
  ProjectChangeFeed,
  ProjectChangeListener,
  ProjectChangeListOptions,
  ProjectChangeRecord,
} from './change-feed.js'
import { ProjectError } from './errors.js'

const MaximumTransactionIdBytes = 512

export interface ProjectTransactionInput {
  readonly transactionId: string
}

/**
 * The complete transaction surface intended for Desktop and Editor consumers.
 * Root paths, persistence paths, policies, providers and edit preparation stay
 * on the host-owned ProjectKernel and cannot cross this boundary by accident.
 */
export interface ProjectTransactionController extends ProjectChangeFeed {
  apply(input: ProjectTransactionInput): Promise<ApplyResult>
  rollback(input: ProjectTransactionInput): Promise<RollbackResult>
}

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
