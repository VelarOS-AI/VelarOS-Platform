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

/** 能力模块的统一前缀；与 `@velaros-ai/code-surface` 的 `CapabilityModulePrefix` 必须一致。 */
export const CapabilityModulePrefix = 'velar:'

/**
 * 一次调用就能做多件事的方法：`ns.method`。
 *
 * 为什么要专门登记：工具面里模型**没法**循环，一轮一次调用，批量形状是白送的；
 * 代码面里 `for (const f of files) await edit({ files: [f] })` 是它最顺手的写法，
 * 而那会把**一次原子批量**变成 N 次——N 次审批、N 个事务、N 个撤销句柄，
 * 中途失败时前面几件已经落了地。形状没变，代价全变了。
 *
 * 所以这些方法的 `@AgentView` 说明里必须有 {@link BatchHint}，生成器逐条核对。
 * 新增批量能力时往这里加一行；漏加的话门禁看不见它，这是登记制的已知边界。
 */
export const BatchShapedOperations = new Set([
  'system.read',
  'system.view',
  'system.edit',
])

/** 上面那些方法的说明里必须出现的一句；核对的是这个子串。 */
export const BatchHint = '一次调用做多个，不要写循环'
