declare module 'velaros:modules' {
  /**
   * 能力发现：只列本会话真能 import 的模块，列出来的直接 import，不用申请；列不出来的这个会话装不上，换现有的能力做，或者在回复里说明缺什么。
   * 拿不准某个模块怎么用时 describe 它，把 declarations 或 template 用 output 交出来再看。
   */

  /** 分页列出模块，可按 space 只看系统成员或业务能力。
   */
  export function list(input?: SystemModuleQuery): Promise<SystemModulePage>

  /** 按关键词找模块：匹配模块名、简介与操作名。
   */
  export function search(input?: SystemModuleQuery): Promise<SystemModulePage>

  /** 读一个模块的合同：完整声明、用法示例与每个操作的说明。
   */
  export function describe(input: SystemModuleDescribeInput): Promise<SystemModuleDescription>

  /**
   * 找模块：query 按模块名、简介与操作名匹配关键词；space 只看 system（velaros:system 的成员）或 capability（业务能力），默认全部。
   * 按 offset 翻页，limit 默认 20、最多 64。
   */
  interface SystemModuleQuery {
    readonly query?: string
    readonly offset?: number
    readonly limit?: number
    readonly space?: 'system' | 'capability' | 'all'
  }

  /** 模块目录的一页；nextOffset 不是 null 就还有下一页。 */
  interface SystemModulePage {
    readonly items: readonly SystemModuleCard[]
    readonly nextOffset: number | null
  }

  /** 要读哪个模块的合同：module 是 import 用的名字；读 velaros:system 时可以用 export 只要一个成员（goal、memory、store、modules）。 */
  interface SystemModuleDescribeInput {
    readonly module: string
    readonly export?: string
  }

  /**
   * 模块的合同：declarations 是完整的 TypeScript 声明，template 是用法示例（只是示例，按需要改写；外部接入的模块没有示例时是空字符串），两者都要 output 之后才看得到。
   * operations 按操作名给出摘要、入参与回执的 schema、效果与允许的入口；读整个 velaros:system 时 exports 按成员给出各自的这些内容。
   */
  interface SystemModuleDescription {
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

  /** 一个能 import 的模块。operations 是能调的操作名，velaros:system 写成「成员.操作」；exports 是 velaros:system 当前能用的成员。 */
  interface SystemModuleCard {
    readonly specifier: string
    readonly space: 'system' | 'capability'
    readonly summary: string
    readonly operations: readonly string[]
    readonly binding?: ModuleBinding
    readonly exports?: readonly string[]
  }

  /**
   * 模块这一次挂载的身份：moduleId 就是 import 用的模块名，instanceId 与 generation 标识实例，schemaRevision 是合同版本。
   */
  interface ModuleBinding {
    readonly moduleId: string
    readonly instanceId: string
    readonly generation: number
    readonly schemaRevision: string
  }
}
