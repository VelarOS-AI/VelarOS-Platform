// 代码面登记：哪些能力以什么命名空间进模型可观测面。门禁与生成器的单一来源。
//
// 这里只登记**根**（命名空间 + 操作接口）；具体放出哪几个方法，看方法上有没有 `@AgentView`。
// 根引用到的类型由机器算闭包，不在这里登记——手工维护闭包一定会烂。
// 闭包里的每个类型必须带 `@AgentView`，门禁双向守（在闭包里没标、标了不在闭包里，都红）。

export const CodeSurfaces = [
  {
    /** 模型在程序里写成 `system.read(...)` 的那个名字。 */
    namespace: 'system',
    /** 相对 packages/ 的目录。 */
    directory: 'system',
    /** 操作接口；方法带 `@AgentView` 的才进模型面。 */
    interfaces: ['SystemFileOperationsApi', 'SystemExecutionOperationsApi'],
  },
  {
    /**
     * 第一个**跨空间**的命名空间：不挂在 `system.` 或 `project.` 下。
     *
     * 沙箱引擎本来就只有一份，重复的只是模型面（两个工具定义、两套说明）。在工具面合并会更乱——
     * 要引入 scope 判别式，每个字段都变条件字段；在代码面它自然是一份：作用域变成宿主按空间注入的
     * `SandboxSurfacePort`，模型这边只剩一套说明，不再挑「这是哪个空间的沙箱」。
     */
    namespace: 'sandbox',
    directory: 'rehearsal-sandbox',
    interfaces: ['SandboxOperationsApi'],
  },
]

/**
 * 宿主管道参数：执行上下文，不是模型能填的入参，生成时整个丢掉。
 * 登记在这里而不是靠猜，是因为丢错一个参数模型就会写出调不通的程序。
 */
export const HostContextTypes = new Set([
  'SystemToolContext',
  'ProjectToolContext',
  'ToolContext',
  'KernelToolContext',
  'SandboxOperationContext',
])

/** 进模型可观测面的标记；打在操作方法与它引用到的每个**领域类型**上。 */
export const AgentViewTag = '@AgentView'

/**
 * 模型可观测面上**禁用**的类型别名：一律写原生形式。
 *
 * 它们是仓库内部的语言层管道（`types/velaros-globals.d.ts`），模型那边没有全局，
 * 硬把它们塞进声明只是给模型多背一层间接。`Nullable<string>` 写成 `string | null`，
 * `Optional<T>` 写成 `T | undefined`——模型天天见的就是原生写法。
 */
export const BannedModelFacingAliases = Object.freeze({
  Nullable: 'T | null',
  Optional: 'T | undefined',
  LooseOptional: 'T | null | undefined',
  Nullish: 'null | undefined',
  PlainObject: 'Record<string, unknown>',
})
