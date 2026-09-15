/**
 * 有限事务面：`ProjectTransactionController` 与工厂 `createProjectTransactionController`。接口 `ProjectTransactionControllerApi` 在本文件的类上方。
 */

import type { ProjectChangeFeed } from '../../contract/provides.js'
import type { ProjectChangeListener, ProjectChangeListOptions, ProjectChangeRecord } from '../../types/change-feed.js'
import type { ApplyResult, RollbackResult } from '../../types/edit.js'
import type { ProjectTransactionInput } from '../../types/transaction.js'
import { normalizeTransactionId } from '../../utils/transactions/change-records.js'

import type { ProjectKernel } from './LocalProjectKernel.js'

/**
 * 给编辑器、工作台、审计界面的有限事务面：只能列出、查看、订阅变更记录，按事务号应用或回滚。
 * 项目根、状态路径、provider 和准备编辑的能力都留在宿主手里的内核上，过不了这道边界；实例上没有可枚举的状态。事务号是非空、有界的字符串。
 */
export interface ProjectTransactionControllerApi extends ProjectChangeFeed {
  /** 应用一个已经准备好的事务。 */
  apply(input: ProjectTransactionInput): Promise<ApplyResult>
  /** 回滚一个已经应用的事务。 */
  rollback(input: ProjectTransactionInput): Promise<RollbackResult>
}

export class ProjectTransactionController implements ProjectTransactionControllerApi {
  readonly #project: Pick<ProjectKernel, 'applyEdit' | 'changeFeed' | 'rollback'>

  public constructor(project: Pick<ProjectKernel, 'applyEdit' | 'changeFeed' | 'rollback'>) {
    this.#project = project
  }

  public list(options?: ProjectChangeListOptions): readonly ProjectChangeRecord[] {
    return this.#project.changeFeed.list(options)
  }

  public get(transactionId: string): ProjectChangeRecord | undefined {
    return this.#project.changeFeed.get(normalizeTransactionId(transactionId))
  }

  public subscribe(listener: ProjectChangeListener): () => void {
    return this.#project.changeFeed.subscribe(listener)
  }

  public apply(input: ProjectTransactionInput): Promise<ApplyResult> {
    return this.#project.applyEdit({ transactionId: normalizeTransactionId(input?.transactionId) })
  }

  public rollback(input: ProjectTransactionInput): Promise<RollbackResult> {
    return this.#project.rollback({ transactionId: normalizeTransactionId(input?.transactionId) })
  }
}

/** 把有限事务面绑到生产者用的同一个内核实例上，交给界面那一侧。 */
export function createProjectTransactionController(project: Pick<ProjectKernel, 'applyEdit' | 'changeFeed' | 'rollback'>): ProjectTransactionControllerApi {
  return new ProjectTransactionController(project)
}
