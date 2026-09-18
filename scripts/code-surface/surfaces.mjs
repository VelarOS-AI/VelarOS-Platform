// 代码面登记：哪些能力以什么命名空间进模型可观测面。门禁与生成器的单一来源。
//
// 这里只登记**根**（命名空间 + 操作接口）；具体放出哪几个方法，看方法上有没有 `@AgentView`。
// 根引用到的类型由机器算闭包，不在这里登记——手工维护闭包一定会烂。
// 闭包里的每个类型必须带 `@AgentView`，门禁双向守（在闭包里没标、标了不在闭包里，都红）。

//
// **命名空间按能力起名，不按空间起名。** 一件能力只有一份实现、一份声明、一份代码模版；
// 每个空间注入自己的端口（作用域、策略、落盘），模型那边不必挑「这是哪个空间的看图」。
// 真正是两件事的不硬合：本机文件（`files`，系统空间）与受项目治理的文件（`project`，项目空间）各是一件能力。
// 空间是一张装配表：给哪些能力、每件能力用哪个端口、哪几件常驻。装空间是产品的事（ADR 0013），端口的本机实现在各单元的 `./local` 入口，
// 项目给共用能力的端口在 `@velaros-ai/velar/project` 的 `projectCapabilityPorts`；仓库层测试照这个写法装的两份在 `tests/support/spaces.ts`。

export const CodeSurfaces = [
  {
    /** 模型在程序里写成 `import { read } from 'velar:files'` 的那个名字。 */
    namespace: 'files',
    /** 相对 packages/ 的目录。 */
    directory: 'velar',
    /** 能力单元的目录（能力按目录放在一个包里时填）；模版相对它找。 */
    unit: 'files',
    /** 操作接口；方法带 `@AgentView` 的才进模型面。 */
    interfaces: ['FileOperationsApi'],
    /** 代码模版：日常最常用写法的示例（只是示例，不要求照着写），import 只写一次；相对单元目录（没有单元就相对包目录）。 */
    templates: 'template.js',
  },
  {
    namespace: 'images',
    directory: 'velar',
    unit: 'images',
    interfaces: ['ImageOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'shell',
    directory: 'velar',
    unit: 'shell',
    interfaces: ['ShellOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'sandbox',
    directory: 'velar',
    unit: 'sandbox',
    interfaces: ['SandboxOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'project',
    directory: 'velar',
    unit: 'project',
    interfaces: ['ProjectFileOperationsApi'],
    templates: 'template.js',
  },
  {
    // 问代码要用项目内核的符号表与读取，和 velar:project 住在同一个单元里；模版各一份
    namespace: 'code',
    directory: 'velar',
    unit: 'project',
    interfaces: ['ProjectCodeOperationsApi'],
    templates: 'code-template.js',
  },
  {
    namespace: 'computer',
    directory: 'velar',
    unit: 'computer',
    interfaces: ['ComputerOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'memory',
    directory: 'velar',
    unit: 'memory',
    interfaces: ['MemoryOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'office',
    directory: 'velar',
    unit: 'office',
    interfaces: ['OfficeOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'browser',
    directory: 'velar',
    unit: 'browser',
    interfaces: ['BrowserOperationsApi'],
    templates: 'template.js',
  },
  {
    // 排障与调页面的那一半：与 velar:browser 共用一个空间端口，住在同一个单元里；模版各一份
    namespace: 'devtools',
    directory: 'velar',
    unit: 'browser',
    interfaces: ['DevtoolsOperationsApi'],
    templates: 'devtools-template.js',
  },
]

/**
 * 宿主管道参数：执行上下文，不是模型能填的入参，生成时整个丢掉。
 * 登记在这里而不是靠猜，是因为丢错一个参数模型就会写出调不通的程序。
 */
export const HostContextTypes = new Set([
  'FileOperationContext',
  'ImageOperationContext',
  'ShellOperationContext',
  'SandboxOperationContext',
  'ProjectOperationContext',
  'ComputerOperationContext',
  'MemoryOperationContext',
  'OfficeOperationContext',
  'BrowserOperationContext',
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
