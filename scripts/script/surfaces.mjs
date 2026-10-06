// 代码面登记：哪些能力以什么命名空间进模型可观测面。门禁与生成器的单一来源。
//
// 这里只登记**根**（命名空间 + 操作接口）；具体放出哪几个方法，看方法上有没有 `@AgentView`。
// 根引用到的类型由机器算闭包，不在这里登记——手工维护闭包一定会烂。
// 闭包里的每个类型必须带 `@AgentView`，门禁双向守（在闭包里没标、标了不在闭包里，都红）。

//
// **命名空间按能力起名，不按空间起名。** 一件能力只有一份实现、一份声明、一份代码模版；
// 每个空间注入自己的端口（作用域、策略、落盘），模型那边不必挑「这是哪个空间的看图」。
// 项目事务文件能力集中在 project，通用执行使用 Node.js、Execa 与 diff。
// 空间是一张装配表：给哪些能力、每件能力用哪个端口、哪几件常驻。装空间是产品的事（ADR 0013），端口的本机实现在各单元的 `./local` 入口，
// 项目给共用能力的端口在 `@velaros-ai/velaros/project` 的 `projectCapabilityPorts`；仓库层测试照这个写法装的两份在 `tests/support/spaces.ts`。

export const CodeSurfaces = [
  {
    namespace: 'images',
    directory: 'velaros',
    unit: 'images',
    interfaces: ['ImageOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'sandbox',
    directory: 'velaros',
    unit: 'sandbox',
    interfaces: ['SandboxOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'project',
    directory: 'velaros',
    unit: 'project',
    interfaces: ['ProjectFileOperationsApi'],
    templates: 'template.js',
  },
  {
    // 问代码要用项目内核的符号表与读取，和 velaros:project 住在同一个单元里；模版各一份
    namespace: 'code',
    directory: 'velaros',
    unit: 'project',
    interfaces: ['ProjectCodeOperationsApi'],
    templates: 'code-template.js',
  },
  {
    namespace: 'computer',
    directory: 'velaros',
    unit: 'computer',
    interfaces: ['ComputerOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'memory',
    directory: 'velaros',
    unit: 'memory',
    interfaces: ['MemoryOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'office',
    directory: 'velaros',
    unit: 'office',
    interfaces: ['OfficeOperationsApi'],
    templates: 'template.js',
  },
  {
    namespace: 'browser',
    directory: 'velaros',
    unit: 'browser',
    interfaces: ['BrowserOperationsApi'],
    templates: 'template.js',
  },
  {
    // 排障与调页面的那一半：与 velaros:browser 共用一个空间端口，住在同一个单元里；模版各一份
    namespace: 'devtools',
    directory: 'velaros',
    unit: 'browser',
    interfaces: ['DevtoolsOperationsApi'],
    templates: 'devtools-template.js',
  },
  {
    // 模型自己的一条 CDP 会话：与另两件共用空间端口，住在同一个单元里；模版各一份
    namespace: 'cdp',
    directory: 'velaros',
    unit: 'browser',
    interfaces: ['CdpOperationsApi'],
    templates: 'cdp-template.js',
  },
  {
    // 网上查资料：搜索引擎搜、把网页读成文字，都在宿主给的不显示页面里跑；和 velaros:browser 不是一件事（那边是在看得见的页面上动手）
    namespace: 'web',
    directory: 'velaros',
    unit: 'web',
    interfaces: ['WebOperationsApi'],
    templates: 'template.js',
  },
  {
    // 同一个对话里的会话之间交活、传话：会话的一切在宿主那里，单元只有模型面与入参核对
    namespace: 'sessions',
    directory: 'velaros',
    unit: 'sessions',
    interfaces: ['SessionsOperationsApi'],
    templates: 'template.js',
  },
  // ── Act 自管理能力：模型从 velaros:system 导入 goal 成员（聚合包由 act/system 的目录编出），模块身份照旧是 velaros:system-goal
  {
    namespace: 'system-goal',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['GoalOperationsApi'],
    templates: 'goal-template.js',
  },
  {
    // 记忆：模型从 velaros:system 导入 memory 成员；按装配四选一挂上（有没有整理模型 × 有没有长期记忆），实现同一个
    namespace: 'system-memory-local',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['SystemMemoryOperationsWorkingApi'],
    templates: 'memory-local-template.js',
  },
  {
    namespace: 'system-memory',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['SystemMemoryOperationsWorkingApi', 'SystemMemoryOperationsOrganizeApi'],
    templates: 'memory-template.js',
  },
  {
    namespace: 'system-memory-persistent-local',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['SystemMemoryOperationsLongTermApi', 'SystemMemoryOperationsWorkingApi'],
    templates: ['memory-local-template.js', 'memory-long-term-template.js'],
  },
  {
    namespace: 'system-memory-persistent',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: [
      'SystemMemoryOperationsLongTermApi',
      'SystemMemoryOperationsWorkingApi',
      'SystemMemoryOperationsOrganizeApi',
    ],
    templates: ['memory-template.js', 'memory-long-term-template.js'],
  },
  {
    // 共享状态：模型从 velaros:system 导入 store 成员；按授权三选一挂上（能建空间 / 能写 / 只读），实现同一个
    namespace: 'system-store',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['StoreOperationsReadApi', 'StoreOperationsWriteApi', 'StoreOperationsCreateApi'],
    templates: 'store-template.js',
  },
  {
    namespace: 'system-store-write',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['StoreOperationsReadApi', 'StoreOperationsWriteApi'],
    templates: 'store-write-template.js',
  },
  {
    namespace: 'system-store-read',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['StoreOperationsReadApi'],
    templates: 'store-read-template.js',
  },
  {
    // 能力发现：模型从 velaros:system 导入 modules 成员
    namespace: 'modules',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['ModulesOperationsApi'],
    templates: 'modules-template.js',
  },
  {
    namespace: 'programs',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['ProgramsOperationsApi'],
    templates: 'programs-template.js',
  },
  {
    // 整理会话读父快照：只挂在整理支线上
    namespace: 'context-materials',
    directory: 'velaros',
    unit: 'act/system',
    interfaces: ['ContextMaterialsOperationsApi'],
    templates: 'context-materials-template.js',
  },
  {
    // 向用户或父任务要信息、确认与能力
    namespace: 'interaction',
    directory: 'velaros',
    unit: 'act/agents',
    interfaces: ['InteractionOperationsApi'],
    templates: 'interaction-template.js',
  },
  {
    // 在对话里给用户显示小部件；宿主给了显示端口才挂
    namespace: 'widget',
    directory: 'velaros',
    unit: 'act/agents',
    interfaces: ['WidgetOperationsApi'],
    templates: 'widget-template.js',
  },
  {
    // 同一运行时上的有界子任务
    namespace: 'agents',
    directory: 'velaros',
    unit: 'act/agents',
    interfaces: ['AgentsOperationsApi'],
    templates: 'template.js',
  },
  {
    // 有界高级搜索：另起只读的搜索模型
    namespace: 'search',
    directory: 'velaros',
    unit: 'act/search',
    interfaces: ['SearchOperationsApi'],
    templates: 'template.js',
  },
  {
    // 搜索会话里的来源检索与证据读取：只挂在搜索支线上
    namespace: 'evidence',
    directory: 'velaros',
    unit: 'act/search',
    interfaces: ['EvidenceOperationsApi'],
    templates: 'evidence-template.js',
  },
]

/**
 * 不经 Kernel 的脚本标准模块：`velaros`（交出结果）与 `velaros:program`（这次程序随身带来的参数与大段文本）。
 * 它们由脚本运行器在隔离进程里直接提供，没有操作回执，也就没有 schema；声明同样从源码里带 @AgentView 的接口生成——
 * 接口的每个属性成为模块的一个 `export const`，注释照原样带上。生成物写进 `baselines/script/<namespace>.d.ts`
 * 与所属包的 `contract/surface.ts`（常量名 `constant`），检查器、包编译器与运行时说明都用那一份。
 */
export const StandardSurfaces = [
  {
    specifier: 'velaros',
    namespace: 'velaros',
    directory: 'script',
    interface: 'ScriptStandardLibrary',
    constant: 'VelarosStandardDeclarations',
  },
  {
    specifier: 'velaros:program',
    namespace: 'program',
    directory: 'script',
    interface: 'ScriptProgramData',
    constant: 'ProgramModuleDeclarations',
  },
]

/**
 * 宿主管道参数：执行上下文，不是模型能填的入参，生成时整个丢掉。
 * 登记在这里而不是靠猜，是因为丢错一个参数模型就会写出调不通的程序。
 */
export const HostContextTypes = new Set([
  'ImageOperationContext',
  'SandboxOperationContext',
  'ProjectOperationContext',
  'ComputerOperationContext',
  'MemoryOperationContext',
  'OfficeOperationContext',
  'BrowserOperationContext',
  'WebOperationContext',
  'SessionsOperationContext',
  'GoalOperationContext',
  'ModulesOperationContext',
  'ProgramsOperationContext',
  'StoreOperationContext',
  'SystemMemoryOperationContext',
  'ContextMaterialsOperationContext',
  'InteractionOperationContext',
  'WidgetOperationContext',
  'AgentsOperationContext',
  'SearchOperationContext',
  'EvidenceOperationContext',
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

/** 能力模块的统一前缀；与 `@velaros-ai/script` 的 `CapabilityModulePrefix` 必须一致。 */
export const CapabilityModulePrefix = 'velaros:'

/** 能力模块在包里的常量名：`velaros:project` → `VelarProjectModule`，`velaros:system-goal` → `VelarSystemGoalModule`。 */
export function surfaceConstantName(namespace) {
  return `Velar${namespace
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')}Module`
}
