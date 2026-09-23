// 模块结构登记：哪些包已进入治理，工具、契约、类型、实现、工具函数各放在哪。
// 方案正文见 docs/architecture/module-ownership.md；本文件是门禁的单一来源。
//
// 字段：
//   directory       相对 packages/ 的目录
//   unit            能力单元的目录名（不填就是普通模块）：几件能力按目录放在同一个包里，共用一份清单与许可；
//                   源码根是 packages/<directory>/<unit>/（不是 src/），其余路径字段仍相对包根写；name 写成「包名/单元」
//   packageEntry    能力单元承载包的根入口；仍按该单元源码目录执行完整治理
//   name            包名
//   toolsFile       工具文件（相对包根，没有工具的包不填）：全部工具定义都在这一个文件里，外加它们的分组与挂载。人最先看的地方，改了要在差量报告里点名；
//                   execute 只放简单的一两步，语句多了就交给 impl 里的类
//   contract        对外合同目录：provides/requires/constants（代码面能力另有生成的 surface.ts）——provides.ts 产品面（交出去的整件能力；类实现的 API 定义在类上方，这里 re-export 登记，
//                   没有类的公开接口直接声明在这里）、requires.ts 注入面（宿主要塞进来的东西）、constants.ts 约定的常量表（工具身份、错误码、
//                   环境变量表、公开上限）。改这三个文件等于改对外契约
//   types           类型目录或单文件：只放类型、一个值都没有，按域分文件；哪些出包由合同的签名闭包决定。
//                   可移植文件 = types/<portable> + contract/constants.ts：不 import（可移植类型文件只许从常量表 import type）、不用 Node 类型、不带函数成员
//   portable        单一可移植数据文件（相对 types，可选），供整文件导出与无行为检查；多份数据按职责留在 types，入口逐项 export type，公开数据必须属于签名闭包
//   impl            实现目录：默认扁平，文件较多时按域分组，每个子目录至少直接放三个源文件。一个类一个文件，文件名就是类名（工具文件除外，它不放类）；
//                   每个类实现一个接口（公开的定义在类上方并在 provides.ts 登记，注入面的在 requires.ts），公开成员不超出接口，私有方法必须用到实例状态
//   utils           纯工具函数目录或单文件：按类别组织，子目录至少直接放三个源文件；只放函数和常量，每个函数上方一句中文说明，只引 utils、types 与合同
//   tuning          可调参数文件（相对 utils，没有可调参数的包不填）：超时、缓冲、保留条数、缺省条数、阈值集中在这一个冻结表里，每项一句说明、每项有人用；
//                   数字缺省值不许散在 impl 与 utils。对外承诺的上限不在这里，在 contract/constants.ts
//                   （对外入口不登记：入口文件就是 src 根上的那几个 .ts，与 package.json 的 exports 一一对应，
//                   入口按能力单元或运行环境边界登记；它们编译成 dist/<名>.js 与 dist/<名>.d.ts）
//   browserSafeEntries  会被渲染进程加载的入口（模块源码根上的入口文件名，嵌套子路径写成 protocol/message.ts）：整条引用链不许出现 Node 内置模块
//   environmentTable    常量表里登记环境变量的表名（不读环境变量的包不填；不填时代码里出现环境变量名就拦）
//   environmentPrefixes 除 VELAROS_ 外还要扫的环境变量前缀（读别人定义、改不了的名字时才填）：只扩大扫描面，不是豁免，
//                       登记的名字照样要有人用、代码里的名字照样要先登记；新起的变量名一律 VELAROS_
//   hostPort            注入面里的端口接口名；端口只放真会被调的方法，门禁从模型面入口（surfaceFile，没有就是 toolsFile）出发沿 import 核对
//   hostPortField       调端口时的字段名（ctx.<字段>.方法 或 this.<字段>.方法）；登记了 hostPort 就必须写
//   surfaceFile         模型面入口（相对包根）：代码面能力的操作类，或空间的装配表；端口可达性从这里出发。一个单元出几件能力、各有操作类时写成数组
//   assets              单元里随包发布的非 TypeScript 资产目录（只有能力单元填，写单元目录下的目录名）：比如 helper 脚本。门禁不扫里面的文件，
//                       但它必须真在、并且写进包清单的 files（`<单元>/<目录>`），不然装出来的包里没有它
//   status              'migrating' 表示正在按标准改造：问题照查照报条数，不计入失败（改造完删掉这一项）
//   lazyImports         允许动态 import() 的目标（不填的包一条都不许有）：每项 { specifier, file, reason }——
//                       specifier 是 import() 里的字符串原文，file 是唯一允许加载它的源文件（相对包根），
//                       reason 一句话写清为什么必须懒加载。登记过的目标必须真有人加载，没人用的要删
//   layers          实现文件的分层（文件名），从上到下；上层可以引下层与同层，下层不许引上层；每个实现文件都要登记在某一层
//   toolDefiner     定义工具的函数名；它只许在工具文件里被调用，保证工具定义一个不漏都在那里
//   card            模块卡片（相对包根）
//   invariants      不变量登记表
//   acceptance      验收测试文件；每条「测试」档不变量都要在这里有以编号开头的用例
export const GovernedModules = [
  {
    directory: 'velaros',
    unit: 'act/runtime',
    name: '@velaros-ai/velaros/act/runtime',
    contract: 'act/runtime/contract',
    types: 'act/runtime/types',
    impl: 'act/runtime/impl',
    utils: 'act/runtime/utils',
    layers: [
      [
        'CapabilityModules.ts',
        'ProgramContext.ts',
        'ActEventProjector.ts',
        'BudgetedModelDriver.ts',
        'ModelToolRuntime.ts',
        'ModelToolActivation.ts',
        'ContextMaintenance.ts',
        'ContextPatchStore.ts',
        'SessionGoal.ts',
        'RuntimeSession.ts',
        'ContextMemory.ts',
        'ScriptTurnDecoder.ts',
        'McpClientConnection.ts',
        'RuntimeTrace.ts',
        'RecentContext.ts',
        'StandardModules.ts',
        'RuntimeBootstrap.ts',
        'RuntimeWorkspaceBinding.ts',
        'EventDelivery.ts',
        'EffectScheduler.ts',
        'RuntimeDiagnostics.ts',
        'ComposedRuntime.ts',
      ],
    ],
    card: 'act/runtime/MODULE.md',
    invariants: 'act/runtime/invariants.md',
    acceptance: 'act/runtime/test/runtime.test.mjs',
    packageEntry: true,
    browserSafeEntries: ['contracts.ts', 'renderer.ts'],
    tuning: 'tuning.ts',
  },
  {
    directory: 'velaros',
    unit: 'act/system',
    name: '@velaros-ai/velaros/act/system',
    contract: 'act/system/contract',
    types: 'act/system/types',
    impl: 'act/system/impl',
    utils: 'act/system/utils',
    surfaceFile: [
      'act/system/impl/GoalOperations.ts',
      'act/system/impl/ModulesOperations.ts',
      'act/system/impl/SystemMemoryOperations.ts',
      'act/system/impl/StoreOperations.ts',
      'act/system/impl/ContextMaterialsOperations.ts',
    ],
    layers: [
      ['SystemModules.ts'],
      [
        'GoalModule.ts',
        'ModulesModule.ts',
        'MemoryModule.ts',
        'ContextModule.ts',
        'StoreModule.ts',
      ],
      [
        'GoalOperations.ts',
        'ModulesOperations.ts',
        'SystemMemoryOperations.ts',
        'StoreOperations.ts',
        'ContextMaterialsOperations.ts',
        'SystemCatalog.ts',
        'ContextMaintenanceState.ts',
        'StoreSession.ts',
      ],
    ],
    card: 'act/system/MODULE.md',
    invariants: 'act/system/spec/invariants.md',
    acceptance: 'act/system/spec/acceptance.test.mjs',
  },
  {
    directory: 'velaros',
    unit: 'act/search',
    name: '@velaros-ai/velaros/act/search',
    contract: 'act/search/contract',
    types: 'act/search/types.ts',
    impl: 'act/search/impl',
    utils: 'act/search/utils',
    surfaceFile: ['act/search/impl/SearchOperations.ts', 'act/search/impl/EvidenceOperations.ts'],
    layers: [
      ['SearchModule.ts', 'EvidenceModule.ts', 'AdvancedSearch.ts'],
      ['SearchOperations.ts', 'EvidenceOperations.ts', 'SearchActivation.ts'],
    ],
    card: 'act/search/MODULE.md',
    invariants: 'act/search/spec/invariants.md',
    acceptance: 'act/search/spec/acceptance.test.mjs',
    tuning: 'tuning.ts',
  },
  {
    directory: 'velaros',
    unit: 'act/agents',
    name: '@velaros-ai/velaros/act/agents',
    contract: 'act/agents/contract',
    types: 'act/agents/types',
    impl: 'act/agents/impl',
    utils: 'act/agents/utils',
    surfaceFile: [
      'act/agents/impl/AgentsOperations.ts',
      'act/agents/impl/InteractionOperations.ts',
    ],
    layers: [
      ['AgentsModule.ts', 'InteractionModule.ts'],
      ['AgentsOperations.ts', 'InteractionOperations.ts'],
    ],
    card: 'act/agents/MODULE.md',
    invariants: 'act/agents/spec/invariants.md',
    acceptance: 'act/agents/spec/acceptance.test.mjs',
  },
  {
    directory: 'context',
    name: '@velaros-ai/context',
    contract: 'src/contract',
    types: 'src/types',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    layers: [
      ['ContextViewSession.ts', 'LocalContextStorage.ts', 'TurnContextSessionLedgers.ts'],
      [
        'ContextEvidenceBuilder.ts',
        'SessionContext.ts',
        'ContextInvocationJournal.ts',
        'LocalStoreStorage.ts',
        'TurnContextLedger.ts',
      ],
      ['EvidenceAccess.ts', 'TurnContextAppendHub.ts'],
    ],
    browserSafeEntries: ['index.ts', 'contracts.ts'],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'test/context.test.mjs',
  },
  {
    directory: 'agent',
    name: '@velaros-ai/agent',
    contract: 'src/contract',
    types: 'src/types',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    layers: [['AgentSupervisor.ts', 'ActRunService.ts'], ['ActLoop.ts']],
    browserSafeEntries: ['contracts.ts'],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    // 底层单元：@velaros-ai/core 里按目录放的底层能力（跨平台约定、磁盘文本、路径规则），布局与能力单元一样，清单与许可只在包根一份；
    // core 自己的基础原语在 src/，不在这张登记表里
    directory: 'core',
    unit: 'platform',
    name: '@velaros-ai/core/platform',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'platform/contract',
    types: 'platform/types',
    portable: 'platform.ts',
    impl: 'platform/impl',
    utils: 'platform/utils',
    browserSafeEntries: ['index.ts', 'contracts.ts'],
    environmentTable: 'PlatformEnvironmentVariables',
    layers: [
      // 兼容层与共享资源目录互不依赖
      ['PlatformCompatibility.ts', 'VelarOSSharedResources.ts'],
    ],
    card: 'platform/MODULE.md',
    invariants: 'platform/spec/invariants.md',
    acceptance: 'platform/spec/acceptance.test.ts',
  },
  {
    directory: 'core',
    unit: 'text-files',
    name: '@velaros-ai/core/text-files',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'text-files/contract',
    types: 'text-files/types',
    portable: 'text-files.ts',
    impl: 'text-files/impl',
    utils: 'text-files/utils',
    tuning: 'tuning.ts',
    // 根入口读写磁盘，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    layers: [
      // 文件读写：原子替换、有界读、流式读，编解码交给下一层
      ['TextFileIo.ts'],
      // 编解码：认编码、严格解码、无损写回
      ['TextCodec.ts'],
      // 一次流式编码识别
      ['TextEncodingProbe.ts'],
      // 按块严格解码一段字节流
      ['TextStreamDecoder.ts'],
    ],
    card: 'text-files/MODULE.md',
    invariants: 'text-files/spec/invariants.md',
    acceptance: 'text-files/spec/acceptance.test.ts',
  },
  {
    directory: 'core',
    unit: 'path-rules',
    name: '@velaros-ai/core/path-rules',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'path-rules/contract',
    types: 'path-rules/types',
    portable: 'path-rules.ts',
    impl: 'path-rules/impl',
    utils: 'path-rules/utils',
    tuning: 'tuning.ts',
    // 遍历要读 .gitignore，根入口只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    layers: [
      // 遍历忽略策略：找规则根、攒规则、问 git
      ['IgnorePolicy.ts'],
      // .gitignore 的解析与判定
      ['GitignoreRules.ts'],
      // glob 匹配
      ['PathMatcher.ts'],
    ],
    card: 'path-rules/MODULE.md',
    invariants: 'path-rules/spec/invariants.md',
    acceptance: 'path-rules/spec/acceptance.test.ts',
  },
  {
    // 能力单元：@velaros-ai/velaros 里按目录放的几件能力，布局一样，清单与许可只在包根一份
    directory: 'velaros',
    unit: 'files',
    name: '@velaros-ai/velaros/files',
    contract: 'files/contract',
    types: 'files/types',
    portable: 'files.ts',
    impl: 'files/impl',
    utils: 'files/utils',
    tuning: 'tuning.ts',
    // 根入口读磁盘，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    // 空间端口：velaros:files 的操作经 ctx.files 调它；每个方法都必须有操作在调
    hostPort: 'FileSpacePort',
    hostPortField: 'files',
    surfaceFile: 'files/impl/FileOperations.ts',
    layers: [
      // 代码面 files 命名空间的三个操作，与本机实现（本机文件端口、给宿主界面的全局搜索），互不依赖
      ['FileOperations.ts', 'LocalFilePort.ts', 'LocalFileSearch.ts'],
      // 留着能撤回的改动
      ['FileChanges.ts'],
    ],
    card: 'files/MODULE.md',
    invariants: 'files/spec/invariants.md',
    acceptance: 'files/spec/acceptance.test.ts',
  },
  {
    directory: 'velaros',
    unit: 'images',
    name: '@velaros-ai/velaros/images',
    contract: 'images/contract',
    types: 'images/types',
    portable: 'images.ts',
    impl: 'images/impl',
    utils: 'images/utils',
    tuning: 'tuning.ts',
    // 根入口读磁盘，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    // 空间端口：velaros:images 的 view 经 ctx.images 调它；每个方法都必须有操作在调
    hostPort: 'ImageSpacePort',
    hostPortField: 'images',
    surfaceFile: 'images/impl/ImageOperations.ts',
    layers: [
      // 代码面 images 命名空间的 view，与本机看图端口，互不依赖
      ['ImageOperations.ts', 'LocalImagePort.ts'],
    ],
    card: 'images/MODULE.md',
    invariants: 'images/spec/invariants.md',
    acceptance: 'images/spec/acceptance.test.ts',
  },
  {
    directory: 'velaros',
    unit: 'shell',
    name: '@velaros-ai/velaros/shell',
    contract: 'shell/contract',
    types: 'shell/types',
    portable: 'shell-command.ts',
    impl: 'shell/impl',
    utils: 'shell/utils',
    // 本机宿主可调的超时、缓冲、保留条数、指标阈值，一处改全单元生效
    tuning: 'tuning.ts',
    // 根入口与可移植数据渲染进程都能加载：本机实现只从根入口导出类型，值在只给 Node 的 local 入口
    browserSafeEntries: ['index.ts', 'contracts.ts'],
    // 本机宿主读写的环境变量：代码里出现的每个 VELAROS_* 名字都要登记在这里
    environmentTable: 'ShellEnvironmentVariables',
    // 空间端口：velaros:shell 的操作经 ctx.shell 调它；每个方法都必须有操作在调
    hostPort: 'ShellSpacePort',
    hostPortField: 'shell',
    surfaceFile: 'shell/impl/ShellOperations.ts',
    // Windows 原生进程宿主（C++ 源码与构建脚本，构建产物放 native/win32-<架构>/）
    assets: ['native'],
    layers: [
      // 代码面 shell 命名空间的操作，与本机实现（本机宿主、受约束执行器、命令执行器、shell 选择、受管子进程），互不依赖
      ['ShellOperations.ts', 'local/'],
      // 命令策略与审批请求互不依赖，上面那一层与演练沙箱共用
      ['ShellCommandPolicy.ts', 'ShellCommandApproval.ts'],
    ],
    card: 'shell/MODULE.md',
    invariants: 'shell/spec/invariants.md',
    acceptance: 'shell/spec/acceptance.test.ts',
  },
  {
    directory: 'velaros',
    unit: 'sandbox',
    name: '@velaros-ai/velaros/sandbox',
    contract: 'sandbox/contract',
    types: 'sandbox/types',
    portable: 'rehearsal-sandbox.ts',
    impl: 'sandbox/impl',
    utils: 'sandbox/utils',
    tuning: 'tuning.ts',
    // 根入口与可移植数据渲染进程都能加载：本机沙箱只从根入口导出类型，值在只给 Node 的 local 入口
    browserSafeEntries: ['index.ts', 'contracts.ts'],
    // 空间端口：velaros:sandbox 的操作经 ctx.sandbox 调它；每个方法都必须有操作在调
    hostPort: 'SandboxSurfacePort',
    hostPortField: 'sandbox',
    surfaceFile: 'sandbox/impl/SandboxOperations.ts',
    layers: [
      // 代码面 sandbox 命名空间的五个操作（解析作用域、调宿主端口、整形回执），与本机演练沙箱，互不依赖
      ['SandboxOperations.ts', 'LocalSandboxHost.ts'],
      // 落回前的核对、镜像里危险命令的确认请求
      ['RehearsalSandboxRules.ts'],
    ],
    card: 'sandbox/MODULE.md',
    invariants: 'sandbox/spec/invariants.md',
    acceptance: 'sandbox/spec/acceptance.test.ts',
  },
  {
    // 能力单元：项目受治理的文件（velaros:project）与问代码（velaros:code），连同它们底下的项目内核。问代码要用内核的符号表与读取，
    // 离不开这个内核，所以两件放在同一个单元里；项目给共用能力装的端口也在这里，把它们装成项目空间是产品的事
    directory: 'velaros',
    unit: 'project',
    name: '@velaros-ai/velaros/project',
    contract: 'project/contract',
    types: 'project/types',
    portable: 'project.ts',
    impl: 'project/impl',
    utils: 'project/utils',
    tuning: 'tuning.ts',
    browserSafeEntries: ['contracts.ts'],
    // 空间端口：两件工具经 ctx.project 调它；每个方法都必须有操作在调
    hostPort: 'ProjectSpacePort',
    hostPortField: 'project',
    surfaceFile: [
      'project/impl/operations/ProjectFileOperations.ts',
      'project/impl/operations/ProjectCodeOperations.ts',
    ],
    layers: [
      // velaros:project、velaros:code 的操作，项目资源门，项目给共用能力装的端口与验证判据
      ['operations/'],
      // 项目内核
      ['kernel/'],
      ['plugins/'],
      ['transactions/', 'files/', 'strategies/', 'adapters/', 'registries/', 'persistence/'],
      // 语言查询与外部语言服务；只借内核的类型与只读端口。
      ['language/ProjectCodeQuery.ts', 'language/ExternalLanguageService.ts'],
      ['language/LanguageQueries.ts', 'language/ExternalLanguageServerClient.ts'],
      ['language/LanguageServiceRegistry.ts'],
      ['language/JsTsLanguageService.ts', 'language/PythonLanguageService.ts'],
      ['language/TypeScriptProjectPool.ts'],
    ],
    card: 'project/MODULE.md',
    invariants: 'project/spec/invariants.md',
    acceptance: 'project/spec/acceptance.test.ts',
  },
  {
    // 能力单元：桌面控制（velaros:computer），连同底下管 Python helper 子进程的运行时与 helper 定位器；
    // 宿主把运行时直接当空间端口交进来（结构上满足），界面要的就绪、屏幕几何、释放也在运行时上
    directory: 'velaros',
    unit: 'computer',
    name: '@velaros-ai/velaros/computer',
    contract: 'computer/contract',
    types: 'computer/types',
    portable: 'computer.ts',
    impl: 'computer/impl',
    utils: 'computer/utils',
    tuning: 'tuning.ts',
    // 根入口要 child_process 拉起 helper，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    environmentTable: 'ComputerEnvironmentVariables',
    // 空间端口：五个操作经 ctx.computer 调它；每个方法都必须有操作在调
    hostPort: 'ComputerSpacePort',
    hostPortField: 'computer',
    surfaceFile: 'computer/impl/ComputerOperations.ts',
    // 随包发布的 Python helper（mac、win、linux 三个平台脚本加共享模块），运行时按平台拉起其中一个
    assets: ['runtime'],
    layers: [
      // 代码面 computer 命名空间的五个操作：入参核对、可用性门禁、结果投影，经空间端口 ctx.computer
      ['ComputerOperations.ts'],
      // 运行时：拉起 Python helper、JSON Lines 协议、按 id 关联请求
      ['ComputerSidecarManager.ts'],
      // helper 定位：按平台与资源根找脚本与自带 venv
      ['ComputerHelperLocator.ts'],
    ],
    card: 'computer/MODULE.md',
    invariants: 'computer/spec/invariants.md',
    acceptance: 'computer/spec/acceptance.test.ts',
  },
  {
    // 能力单元：长期记忆（velaros:memory）：一个作用域一个目录的 Markdown，模型面三个操作；作用域由宿主给，记忆不解释它，只按它隔离
    directory: 'velaros',
    unit: 'memory',
    name: '@velaros-ai/velaros/memory',
    contract: 'memory/contract',
    types: 'memory/types',
    portable: 'memory.ts',
    impl: 'memory/impl',
    utils: 'memory/utils',
    tuning: 'tuning.ts',
    // 根入口读写磁盘，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    // 作用域端口：三个操作经 ctx.memory 调它；每个方法都必须有操作在调
    hostPort: 'MemoryScopePort',
    hostPortField: 'memory',
    surfaceFile: 'memory/impl/MemoryOperations.ts',
    layers: [
      // 代码面 memory 命名空间的三个操作：查取消，再经 ctx.memory 调作用域
      ['MemoryOperations.ts'],
      // 记忆库：根目录下按作用域分目录，列出有记忆的作用域
      ['MemoryStore.ts'],
      // 一个作用域：读写目录里的条目，排会话开场的索引
      ['MemoryScope.ts'],
    ],
    card: 'memory/MODULE.md',
    invariants: 'memory/spec/invariants.md',
    acceptance: 'memory/spec/acceptance.test.ts',
  },
  {
    // 能力单元：办公文档（velaros:office），整包并进来的：模型面的九个操作，连同底下的 Word、PowerPoint、Excel、PDF 引擎、
    // 外部转换器（LibreOffice、LaTeX、MarkItDown）与给 Document Renderer 的窄渲染原语
    directory: 'velaros',
    unit: 'office',
    name: '@velaros-ai/velaros/office',
    contract: 'office/contract',
    types: 'office/types',
    portable: 'office.ts',
    impl: 'office/impl',
    utils: 'office/utils',
    tuning: 'tuning.ts',
    // 根入口要 docx / exceljs / pdfjs 与磁盘，渲染入口要 canvas 与 pdfjs，都只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    environmentTable: 'OfficeEnvironmentVariables',
    // 空间端口：九个操作经 ctx.office 调它；每个方法都必须有操作在调
    hostPort: 'OfficeSpacePort',
    hostPortField: 'office',
    surfaceFile: 'office/impl/OfficeOperations.ts',
    // 随包审过的 PptxGenJS ESM 运行时（带本地安全补丁），经包清单的子路径导入 #pptxgenjs 取用
    assets: ['vendor'],
    layers: [
      // 代码面 office 命名空间的九个操作：入参核对，交给执行类
      ['OfficeOperations.ts'],
      // 执行：Word、PowerPoint、Excel 生成，PDF，预览，Markdown，外部转换器，工作区路径门
      ['operations/'],
      // 运行时：pdfjs 装载、MarkItDown 定位、给 Document Renderer 的渲染面
      ['runtime/'],
    ],
    card: 'office/MODULE.md',
    invariants: 'office/spec/invariants.md',
    acceptance: 'office/spec/acceptance.test.ts',
  },
  {
    // 能力单元：浏览器（velaros:browser、velaros:devtools 与 velaros:cdp），整包并进来的：模型面的三件能力，连同底下的 CDP 驱动、交互 / 页面数据 / 截图 / 性能引擎、
    // Electron 会话运行时、站点工作区、登录墙、用户脚本存储、动作策略与页面脚本；地址栏、偏好、截图策略与 React 合成给渲染进程
    directory: 'velaros',
    unit: 'browser',
    name: '@velaros-ai/velaros/browser',
    contract: 'browser/contract',
    types: 'browser/types',
    portable: 'browser.ts',
    impl: 'browser/impl',
    utils: 'browser/utils',
    tuning: 'tuning.ts',
    // 渲染进程会加载这两个：可移植数据与渲染进程要的那几件纯策略值
    browserSafeEntries: ['contracts.ts', 'renderer.ts'],
    // 空间端口：三件能力经 ctx.browser 调它（已经绑好会话与站点）；每个方法都必须有操作在调
    hostPort: 'BrowserSpacePort',
    hostPortField: 'browser',
    surfaceFile: [
      'browser/impl/BrowserOperations.ts',
      'browser/impl/DevtoolsOperations.ts',
      'browser/impl/CdpOperations.ts',
    ],
    // 随包的 DevTools 性能引擎（约 2.5 MB 的生成产物），经包清单的子路径导入 #devtools-performance-engine 取用
    assets: ['vendor'],
    layers: [
      // 代码面 browser、devtools、cdp 三个命名空间的操作：入参核对，交给端口
      ['BrowserOperations.ts', 'DevtoolsOperations.ts', 'CdpOperations.ts'],
      // 运行时装配：Electron 运行时
      ['electron/'],
      // 领域引擎：交互、页面数据、截图、性能
      ['engines/'],
      // 协议、会话状态、站点工作区，互不依赖
      ['cdp/', 'session/', 'workspace/'],
      // 纯策略门面与 React 合成
      ['policies/', 'BrowserComposition.ts'],
    ],
    // 性能引擎是 2.5 MB 的 vendor 产物，静态 import 会让每个加载本单元的进程都付这笔钱；
    // 它只在真跑 trace 时才用得到，所以登记成唯一一个懒加载目标。
    lazyImports: [
      {
        specifier: '#devtools-performance-engine',
        file: 'browser/impl/engines/BrowserPerformanceTraceEngine.ts',
        reason: 'vendor DevTools 性能引擎约 2.5 MB，只在解析 trace 与出 insight 时才加载',
      },
    ],
    card: 'browser/MODULE.md',
    invariants: 'browser/spec/invariants.md',
    acceptance: 'browser/spec/acceptance.test.ts',
  },
  {
    directory: 'script',
    name: '@velaros-ai/script',
    // Script 执行引擎：检查、精确编辑、隔离执行与 Kernel 能力桥；模型入口由 Velaros 装配
    contract: 'src/contract',
    types: 'src/types',
    portable: 'script.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    // 根入口起子进程、跑编译器，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    layers: [
      // Kernel 会话编排检查与一次执行
      ['KernelScriptSession.ts', 'ScriptPackageCompiler.ts', 'ScriptOutputs.ts'],
      ['CodeSurfaceSession.ts'],
      // 执行前的检查与隔离运行器
      ['CodeProgramChecker.ts', 'NodeSubprocessCodeRunner.ts'],
      ['SubprocessCodeRunner.ts', 'ScriptWorker.ts', 'NodeScriptProcess.ts'],
      // 能力转发：操作表与 Kernel 调用统一转换成脚本端口
      ['CapabilityOperationPort.ts', 'KernelInvocationPort.ts'],
    ],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'agent-lab',
    name: '@velaros-ai/agent-lab',
    // 没有模型面工具：本包是评测基础设施，不给 agent 挂工具，所以不登记 toolsFile、toolDefiner、hostPort
    contract: 'src/contract',
    types: 'src/types',
    portable: 'agent-lab.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    // 根入口读写归档、拉起命令行，只给 Node；渲染进程与第三方工具链只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    // 不读任何环境变量：地址、凭据、驱动全部由宿主从注入面塞进来，所以不登记环境变量表
    layers: [
      // 命令行：六条命令，只把参数折成对下面几件能力的调用
      ['AgentLabCli.ts'],
      // 跑与存：一条旅程走完落成归档，归档读写与真实任务落盘
      ['JourneyRunner.ts', 'LabArchives.ts'],
      // 各件能力与两个注册处；驱动装配在上、轮询驱动本体在下
      [
        'LabDrivers.ts',
        'LabWire.ts',
        'LabReports.ts',
        'LabStatistics.ts',
        'LabCertification.ts',
        'RealTaskWorkload.ts',
        'AdaptiveCampaign.ts',
        'DetectorRegistry.ts',
        'VerifierRegistry.ts',
        'BudgetLedger.ts',
      ],
      // 通用轮询驱动：唯一一个内置驱动，认协议的驱动由宿主注册
      ['PollingDriver.ts'],
    ],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'kernel',
    name: '@velaros-ai/kernel',
    // 没有模型面工具：不登记 toolsFile、toolDefiner、hostPort（同 platform）
    contract: 'src/contract',
    types: 'src/types',
    portable: 'kernel.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    // 根入口是进程内内核与模块 SDK，渲染进程要加载；serve、client、remote 三个入口是 Node 专用
    browserSafeEntries: ['index.ts', 'contracts.ts'],
    environmentTable: 'KernelEnvironmentVariables',
    layers: [
      // 进程侧装配：协议服务面、守护进程、本机 RPC、mod 仓库与装载、进程内传输、启动器
      ['serve/'],
      // 部署件：瘦客户端、更新器、远程节点两端，互不依赖
      ['client/', 'updater/', 'remote-client/', 'remote-node/'],
      // 进程内内核：模块宿主、唯一调用路径、模块 SDK、mod 信封解析；不碰 Node 模块
      ['runtime/'],
    ],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'model',
    name: '@velaros-ai/model',
    // 没有模型面工具：不登记 toolsFile、toolDefiner、hostPort（同 platform、kernel）。
    // 内核只有一个可调用操作 supports_provider，它的定义跟着组合层的内核能力类走。
    contract: 'src/contract',
    types: 'src/types',
    portable: 'model.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    // 根入口的装配链带 node:vm / node:fs，渲染进程只能加载可移植数据与目录逻辑
    browserSafeEntries: ['contracts.ts', 'catalog.ts'],
    environmentTable: 'ModelEnvironmentVariables',
    layers: [
      // 装配、解析、内核能力；通用请求客户端与产品共用机制（两组互不引用）
      ['composition/', 'requests/'],
      // 各厂商适配器与两个 LanguageModel 包装类
      ['adapters/'],
      // provider 集合、静态目录、环境快照、script 注册表、Cloud 绑定、远端目录服务与缓存
      ['providers/'],
    ],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
]

/** 模块卡片必须有的十节标题，顺序不限。 */
export const RequiredCardSections = [
  '这是什么',
  '提供什么',
  '骨干链路',
  '依赖什么',
  '状态归谁',
  '生命周期',
  '失败语义',
  '不变量',
  '非目标',
  '结构',
]

/** 不变量的五档检验方式。「文字」档没有检验器，在卡片里必须计入「未验证」。 */
export const InvariantCheckKinds = ['测试', '类型', '门禁', '运行时', '文字']
