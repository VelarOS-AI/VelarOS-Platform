import type { ModuleBinding } from '@velaros-ai/kernel'

/**
 * @AgentView
 * 找模块：query 按模块名、简介与操作名匹配关键词；space 只看 system（velaros:system 的成员）或 capability（业务能力），默认全部。
 * 按 offset 翻页，limit 默认 20、最多 64。
 */
export interface SystemModuleQuery {
  readonly query?: string
  readonly offset?: number
  readonly limit?: number
  readonly space?: 'system' | 'capability' | 'all'
}

/** @AgentView 一个能 import 的模块。operations 是能调的操作名，velaros:system 写成「成员.操作」；exports 是 velaros:system 当前能用的成员。 */
export interface SystemModuleCard {
  readonly specifier: string
  readonly space: 'system' | 'capability'
  readonly summary: string
  readonly operations: readonly string[]
  readonly binding?: ModuleBinding
  readonly exports?: readonly string[]
}

/** @AgentView 模块目录的一页；nextOffset 不是 null 就还有下一页。 */
export interface SystemModulePage {
  readonly items: readonly SystemModuleCard[]
  readonly nextOffset: Nullable<number>
}

/**
 * @AgentView
 * 要读哪个模块的合同：module 是 import 用的名字。export 给一个导出名（函数或类型）时只交回它的声明和它用到的类型，比整份声明小得多；
 * 读 velaros:system 时 export 是成员名（goal、memory、store、modules）。
 */
export interface SystemModuleDescribeInput {
  readonly module: string
  readonly export?: string
}

/**
 * @AgentView
 * 模块的合同：declarations 是完整的 TypeScript 声明，template 是用法示例（只是示例，按需要改写；外部接入的模块没有示例时是空字符串），两者都要 output 之后才看得到。
 * operations 按操作名给出摘要、入参与回执的 schema、效果与允许的入口；读整个 velaros:system 时 exports 按成员给出各自的这些内容。
 */
export interface SystemModuleDescription {
  readonly specifier: string
  readonly space: 'system' | 'capability'
  /** 读的是 velaros:system 的哪个成员。 */
  readonly export?: string
  readonly summary?: string
  readonly binding?: ModuleBinding
  readonly operations?: Readonly<Record<string, unknown>>
  readonly exports?: Readonly<Record<string, unknown>>
  readonly declarations: string
  readonly template: string
}
