/**
 * 产品面：本单元交给外面的整件能力——`velar:project` 与 `velar:code` 的操作、项目资源门、项目内核与它的宿主侧部件，
 * 以及项目给共用能力装的端口与验证判据。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口（变更记录的只读视图）直接声明在这里。这里的每个接口都必须从根入口导出。
 */

import type { ProjectChangeListener, ProjectChangeListOptions, ProjectChangeRecord } from '../types/change-feed.js'

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ProjectKernel } from '../impl/kernel/LocalProjectKernel.js'
export type { ProjectTransactionControllerApi } from '../impl/kernel/ProjectTransactionController.js'
export type { ProjectCapabilityPortsApi } from '../impl/operations/ProjectCapabilityPorts.js'
export type { ProjectCodeOperationsApi } from '../impl/operations/ProjectCodeOperations.js'
export type { ProjectExecutionGateApi } from '../impl/operations/ProjectExecutionGate.js'
export type { ProjectFileOperationsApi } from '../impl/operations/ProjectFileOperations.js'
export type { ProjectVerificationPolicyApi } from '../impl/operations/ProjectVerificationPolicy.js'
export type { FileProjectChangeFeedApi } from '../impl/persistence/FileProjectChangeFeed.js'

// ── 变更记录 ────────────────────────────────────────────────────

/** 项目变更记录的只读视图：每次提交的事务一条记录，界面和审计按它列出、查看、订阅项目改动。内核的 `changeFeed` 就是它。 */
export interface ProjectChangeFeed {
  /** 按选项列出变更记录，新的在前。 */
  list(options?: ProjectChangeListOptions): readonly ProjectChangeRecord[]
  /** 按事务号取一条记录；没有返回 undefined。 */
  get(transactionId: string): ProjectChangeRecord | undefined
  /** 订阅记录的增加与状态变化；返回取消订阅的函数。 */
  subscribe(listener: ProjectChangeListener): () => void
}
