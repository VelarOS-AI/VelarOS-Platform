import type { CommandProvider, ProjectProviders } from '../contract/requires.js'

import type { Diagnostic } from './common.js'
import type { CorePolicy } from './policy.js'
import type { CommandToolRequirement } from './provider.js'

export type ProjectValidationPolicy = Readonly<CorePolicy>

export type ReadonlyProvider<Provider> = Provider extends object ? Readonly<Provider> : Provider

export type ProjectValidationProviders = {
  readonly [Key in keyof ProjectProviders]: ReadonlyProvider<ProjectProviders[Key]>
} & {
  readonly command: Readonly<CommandProvider>
}

/** Validator 可观察的最小只读事务投影，不暴露补丁、metadata 或生命周期写入口。 */
export interface ProjectValidationTransaction {
  readonly transactionId: string
  readonly changedFiles: readonly string[]
  readonly changedLines: number
}

/** Validator 运行时可访问的只读项目视图；文件读取优先反映事务暂存内容。 */
export interface ProjectValidationContext {
  readonly root: string
  readonly policy: ProjectValidationPolicy
  readonly providers: ProjectValidationProviders
  readonly getTransaction: (transactionId: string) => ProjectValidationTransaction | undefined
  readonly readFile: (path: string) => Promise<string | undefined>
}

/** 面向事务、显式路径、指定检查项和后置条件的校验请求。 */
export interface ValidateInput {
  transactionId?: string
  paths?: string[]
  checks?: string[]
  postconditions?: Postcondition[]
}

export interface ValidationCheckResult {
  id: string
  ok: boolean
  /** 单个检查项的诊断信息；需要时会汇总到整体结果。 */
  diagnostics?: Diagnostic[]
  metadata?: any
}

export interface ValidationResult {
  ok: boolean
  diagnostics: Diagnostic[]
  checks: ValidationCheckResult[]
  toolRequirements?: CommandToolRequirement[]
}

export interface Postcondition {
  /** 事务准备完成后要检查的声明式不变量。 */
  type:
    | 'must_contain'
    | 'must_not_contain'
    | 'must_keep_symbol'
    | 'must_modify_symbol'
    | 'must_not_modify_symbol'
    | 'changed_files_allowlist'
    | 'max_changed_lines'
    | 'schema_valid'
    | 'layout_preserved'
    | 'formula_preserved'
    | 'custom'
  value: any
}
