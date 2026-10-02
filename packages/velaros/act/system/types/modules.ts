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

/** @AgentView 一个能 import 的模块。operations 是能调的操作名，velaros:system 写成「成员.操作」；exports 是真实值导出名，velaros:system 列成员。contentRevision 标识完整声明与模板正文，与 binding 的实例和 schemaRevision 分开，不表示你已读合同。 */
export interface SystemModuleCard {
  readonly specifier: string
  readonly space: 'system' | 'capability'
  readonly summary: string
  readonly operations: readonly string[]
  readonly binding?: ModuleBinding
  readonly exports: readonly string[]
  readonly contentRevision: string
}

/** @AgentView 模块目录的一页；nextOffset 不是 null 就还有下一页。 */
export interface SystemModulePage {
  readonly items: readonly SystemModuleCard[]
  readonly nextOffset: Nullable<number>
}

/**
 * @AgentView
 * 要读哪个模块的合同：module 是 import 用的名字。exports 选择 1 到 64 个导出名（函数或类型），共同规则和依赖类型只返回一次。
 * 指定导出时默认不附整模块模板，需要示例传 template: true；不指定导出时保留完整声明和模板。template: false 可只取声明。
 * 读 velaros:system 时 exports 是成员名。
 */
export interface SystemModuleDescribeInput {
  readonly module: string
  readonly exports?: readonly string[]
  readonly template?: boolean
}

/**
 * @AgentView
 * 模块的合同：declarations 是所选导出与依赖的 TypeScript 声明，含模块共同规则；未指定导出时给完整声明。template 是按请求交回的用法示例（只是示例，按需要改写；未请求或外部模块没有示例时为空字符串），正文要 output 之后才看得到。
 * operations 按操作名给出摘要、入参与回执的 schema、效果与允许的入口；读整个 velaros:system 时 exports 按成员给出各自的这些内容。
 */
export interface SystemModuleDescription {
  readonly specifier: string
  readonly contentRevision: string
  readonly space: 'system' | 'capability'
  readonly summary?: string
  readonly binding?: ModuleBinding
  readonly operations?: Readonly<Record<string, unknown>>
  readonly exports?: Readonly<Record<string, unknown>>
  readonly declarations: string
  readonly template: string
}
