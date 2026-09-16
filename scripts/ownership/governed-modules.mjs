// 模块结构登记：哪些包已进入治理，工具、契约、实现、对外入口各放在哪。
// 方案正文见 docs/architecture/module-ownership.md；本文件是门禁的单一来源。
//
// 字段：
//   directory       相对 packages/ 的目录
//   name            包名
//   toolsFile       工具文件（相对包根，没有工具的包不填）：全部工具定义都在这一个文件里，外加它们的分组与挂载。人最先看的地方，改了要在差量报告里点名；
//                   execute 只放简单的一两步，语句多了就交给 impl 里的类
//   contract        对外合同目录：只有三个文件——provides.ts 产品面（交出去的整件能力；类实现的 API 定义在类上方，这里 re-export 登记，
//                   没有类的公开接口直接声明在这里）、requires.ts 注入面（宿主要塞进来的东西）、constants.ts 约定的常量表（工具身份、错误码、
//                   环境变量表、公开上限）。改这三个文件等于改对外契约
//   types           类型目录：扁平，只放类型、一个值都没有，按域分文件；哪些出包由合同的签名闭包决定。
//                   可移植文件 = types/<portable> + contract/constants.ts：不 import（可移植类型文件只许从常量表 import type）、不用 Node 类型、不带函数成员
//   portable        可移植数据类型文件（相对 types）；`./contracts` 入口 = 它 + contract/constants.ts
//   impl            实现目录：扁平，不分子目录。一个类一个文件，文件名就是类名（工具文件除外，它不放类）；
//                   每个类实现一个接口（公开的定义在类上方并在 provides.ts 登记，注入面的在 requires.ts），公开成员不超出接口，私有方法必须用到实例状态
//   utils           纯工具函数目录：扁平，按类别分文件；只放函数和常量，每个函数上方一句中文说明，只引 utils、types 与合同
//   tuning          可调参数文件（相对 utils，没有可调参数的包不填）：超时、缓冲、保留条数、缺省条数、阈值集中在这一个冻结表里，每项一句说明、每项有人用；
//                   数字缺省值不许散在 impl 与 utils。对外承诺的上限不在这里，在 contract/constants.ts
//   exports         对外入口所在目录，package.json 的 exports 指向这里编译出来的文件
//   browserSafeEntries  会被渲染进程加载的入口（exports 下的文件名）：整条引用链不许出现 Node 内置模块
//   environmentTable    常量表里登记环境变量的表名（不读环境变量的包不填；不填时代码里出现环境变量名就拦）
//   environmentPrefixes 除 VELAROS_ 外还要扫的环境变量前缀（读别人定义、改不了的名字时才填）：只扩大扫描面，不是豁免，
//                       登记的名字照样要有人用、代码里的名字照样要先登记；新起的变量名一律 VELAROS_
//   hostPort            注入面里的宿主端口接口名；端口只放工具真会调的方法，门禁从工具文件出发沿 import 核对
//   hostPortField       工具上下文里放宿主端口的字段名（ctx.<字段>.方法），缺省 system
//   status              'migrating' 表示正在按标准改造：问题照查照报条数，不计入失败（改造完删掉这一项）
//   layers          实现文件的分层（文件名），从上到下；上层可以引下层与同层，下层不许引上层；每个实现文件都要登记在某一层
//   toolDefiner     定义工具的函数名；它只许在工具文件里被调用，保证工具定义一个不漏都在那里
//   card            模块卡片（相对包根）
//   invariants      不变量登记表
//   acceptance      验收测试文件；每条「测试」档不变量都要在这里有以编号开头的用例
export const GovernedModules = [
  {
    directory: 'agent',
    name: '@velaros-ai/agent',
    toolsFile: 'src/impl/AgentTools.ts',
    contract: 'src/contract',
    types: 'src/types',
    portable: 'agent.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
    browserSafeEntries: [],
    environmentTable: 'AgentEnvironmentVariables',
    status: 'migrating',
    layers: [
      ['AgentTools.ts'],
      ['builtin/'],
      ['assembly/'],
      ['execution/', 'product-session/'],
      ['delegation/'],
      ['runner/'],
      ['loop/'],
      ['session/', 'tools/'],
      ['context/', 'residency/', 'retrieval/'],
      ['guidance/', 'mods/', 'connectors/', 'chat/'],
      ['records/'],
      ['ledgers/'],
      ['errors/'],
    ],
    toolDefiner: 'defineVelaTool',
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'system',
    name: '@velaros-ai/system',
    toolsFile: 'src/impl/SystemTools.ts',
    contract: 'src/contract',
    types: 'src/types',
    portable: 'system.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    // 包内可调参数：超时、缓冲、保留条数、缺省条数、阈值，一处改全包生效
    tuning: 'tuning.ts',
    exports: 'src/exports',
    browserSafeEntries: ['contracts.ts'],
    // 可移植数据文件里的环境变量表：代码里出现的每个 VELAROS_* 名字都要登记在这里
    environmentTable: 'SystemEnvironmentVariables',
    // 宿主端口：注入面里工具经 ctx.system 调的那个接口；它的每个方法都必须有工具在调，没人调的不许留
    hostPort: 'SystemToolSystemApi',
    // 实现文件的分层，从上到下；上层可以引下层与同层，下层不许引上层
    layers: [
      // 工具：七个工具的定义与挂载
      ['SystemTools.ts'],
      // 宿主：宿主端口的本机实现
      ['LocalSystemKernel.ts'],
      // 能力：命令、受管子进程、shell；文件操作与搜索
      [
        'SystemCommandRunner.ts', 'SystemSandboxes.ts', 'SystemShellResolver.ts', 'SystemProcessManager.ts', 'SystemManagedProcess.ts',
        'SystemOutputDecoder.ts', 'SystemExecutionOperations.ts', 'SystemFileOperations.ts', 'SystemFileHistory.ts', 'SystemGlobalSearch.ts',
      ],
      // shell 错误类
      ['SystemShellUnavailableError.ts'],
    ],
    toolDefiner: 'defineSystemTool',
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'project',
    name: '@velaros-ai/project',
    toolsFile: 'src/impl/ProjectTools.ts',
    contract: 'src/contract',
    types: 'src/types',
    portable: 'project.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
    browserSafeEntries: ['contracts.ts'],
    hostPort: 'ProjectToolApi',
    hostPortField: 'project',
    layers: [
      ['ProjectTools.ts'],
      ['operations/'],
      ['kernel/'],
      ['plugins/'],
      ['transactions/', 'files/', 'strategies/', 'adapters/', 'registries/', 'persistence/'],
    ],
    toolDefiner: 'defineProjectTool',
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'platform',
    name: '@velaros-ai/platform',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'src/contract',
    types: 'src/types',
    portable: 'platform.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    exports: 'src/exports',
    browserSafeEntries: ['index.ts', 'contracts.ts'],
    environmentTable: 'PlatformEnvironmentVariables',
    layers: [
      // 兼容层与共享资源目录互不依赖
      ['PlatformCompatibility.ts', 'VelarOSSharedResources.ts'],
    ],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'shell-command',
    name: '@velaros-ai/shell-command',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'src/contract',
    types: 'src/types',
    portable: 'shell-command.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    exports: 'src/exports',
    browserSafeEntries: ['index.ts', 'contracts.ts'],
    layers: [
      // 命令策略与审批请求互不依赖
      ['ShellCommandPolicy.ts', 'ShellCommandApproval.ts'],
    ],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'rehearsal-sandbox',
    name: '@velaros-ai/rehearsal-sandbox',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'src/contract',
    types: 'src/types',
    portable: 'rehearsal-sandbox.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
    browserSafeEntries: ['index.ts', 'contracts.ts'],
    layers: [
      ['RehearsalSandboxRules.ts'],
    ],
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'text-files',
    name: '@velaros-ai/text-files',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'src/contract',
    types: 'src/types',
    portable: 'text-files.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
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
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'path-rules',
    name: '@velaros-ai/path-rules',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'src/contract',
    types: 'src/types',
    portable: 'path-rules.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
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
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
  },
  {
    directory: 'browser',
    name: '@velaros-ai/browser',
    // 改造中：工具还散在 impl/tools/ 的 14 个 *.tool.ts 里，收进一个工具文件是下一段的事，
    // 所以现在不填 toolsFile、toolDefiner、hostPort，也不填卡片与验收；status 标 migrating，
    // 门禁照查照报剩下多少条，不计入失败。
    contract: 'src/contract',
    types: 'src/types',
    portable: 'browser.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
    // 入口收口（四个入口）是下一段的事；现在六个入口的名字一个不变
    browserSafeEntries: ['core-contracts.ts'],
    status: 'migrating',
    layers: [
      // 工具：14 个 *.tool.ts 与它们的 schema、分组、挂载（下一段收成一个 BrowserTools.ts）
      ['tools/'],
      // 工具背后的执行：act / extract / recipe / files 的动作分派
      ['operations/'],
      // 运行时装配：Electron 运行时与无 Electron 的 CDP 运行时
      ['electron/', 'CdpBrowserRuntime.ts', 'CdpBrowserRuntimeContract.ts'],
      // 领域引擎：交互、页面数据、截图、性能
      ['engines/'],
      // 协议、会话状态、站点工作区，互不依赖
      ['cdp/', 'session/', 'workspace/'],
      // 纯策略门面与 React 合成
      ['policies/', 'BrowserComposition.ts'],
    ],
    // 卡片与不变量登记是改造最后一段的事，这三份现在还不存在，照样登记，燃尽表里看得到
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
    exports: 'src/exports',
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
    // 卡片与不变量登记是改造最后一段的事，这三份现在还不存在，照样登记，燃尽表里看得到
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
    // 按仓库标准改造中：问题照查照报条数，不计入失败（改造完删掉这一项）
    status: 'migrating',
  },
  {
    directory: 'memory',
    name: '@velaros-ai/memory',
    // 改造中：下面这些是目标位置，还没到位的照报条数、不计入失败
    // （方案 docs/engineering/refactor-plans/memory.md §2.2–2.6、附录 A）
    toolsFile: 'src/impl/MemoryTools.ts',
    contract: 'src/contract',
    types: 'src/types',
    portable: 'memory.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
    // 根入口要 SQLite 与文件 IO，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    hostPort: 'MemoryToolApi',
    hostPortField: 'memory',
    layers: [
      // 工具：四个记忆工具的定义与挂载
      ['MemoryTools.ts'],
      // 工具执行：execute 交给的类，只经 ctx.memory 调宿主
      ['MemoryToolOperations.ts'],
      // 宿主胶水：装配、证据采集桥、回合召回、树治理门面、空闲整理调度、后端令牌族
      ['host/'],
      // 后端编排与规则：叠加体、树后端适配、动词与派生索引判定、作用域规则
      ['backends/'],
      // 三个互不相引的后端实现
      ['files/', 'vector/', 'tree/'],
      // 树 v2：独立子系统，除探针外没人引它，也不出包
      ['tree-v2/'],
    ],
    toolDefiner: 'defineMemoryTool',
    // 卡片与不变量登记是改造最后一段的事，这三份现在还不存在，照样登记，燃尽表里看得到
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
    status: 'migrating',
  },
  {
    directory: 'knowledge',
    name: '@velaros-ai/knowledge',
    // 改造中：刚从 @velaros-ai/memory 的 /knowledge 子路径整体搬出来成独立包，
    // 源码还是原来的目录形状，五个目录与工具文件是下一段的事（方案 §2.7、附录 B）
    toolsFile: 'src/impl/KnowledgeTools.ts',
    contract: 'src/contract',
    types: 'src/types',
    portable: 'knowledge.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
    // 根入口要 SQLite 与 LanceDB，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    hostPort: 'KnowledgeToolApi',
    hostPortField: 'knowledge',
    layers: [
      // 工具：三个知识工具的定义与挂载
      ['KnowledgeTools.ts'],
      // 工具执行：零命中补一次同步、回执拼装
      ['KnowledgeToolOperations.ts'],
      // 运行时对象图
      ['KnowledgeRuntime.ts'],
      // 领域：门面、查询、写入、维护、摄入、工作区
      ['domain/'],
      // 存储：关系仓、向量表、嵌入客户端
      ['storage/'],
    ],
    toolDefiner: 'defineKnowledgeTool',
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
    status: 'migrating',
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
    exports: 'src/exports',
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
    // 卡片与不变量登记是入口收口那一轮的事，这三份现在还不存在，照样登记，燃尽表里看得到
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
    status: 'migrating',
  },
  {
    directory: 'office',
    name: '@velaros-ai/office',
    toolsFile: 'src/impl/OfficeTools.ts',
    contract: 'src/contract',
    types: 'src/types',
    portable: 'office.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
    // 根入口要 docx / exceljs / pdfjs 与磁盘，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    environmentTable: 'OfficeEnvironmentVariables',
    hostPort: 'OfficeHostApi',
    hostPortField: 'office',
    layers: [
      // 工具：十个 office 工具的定义、分组与挂载
      ['OfficeTools.ts'],
      // 工具执行：授权、写盘、跑外部命令，全经宿主端口 ctx.office
      ['operations/'],
      // 运行时：pdfjs 装载、MarkItDown 定位、给 Document Renderer 的渲染面
      ['runtime/'],
    ],
    toolDefiner: 'defineOfficeTool',
    // 卡片与不变量登记是入口收口那一轮的事，这三份现在还不存在，照样登记，燃尽表里看得到
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
    status: 'migrating',
  },
  {
    directory: 'computer',
    name: '@velaros-ai/computer',
    toolsFile: 'src/impl/ComputerTools.ts',
    contract: 'src/contract',
    types: 'src/types',
    portable: 'computer.ts',
    impl: 'src/impl',
    utils: 'src/utils',
    tuning: 'tuning.ts',
    exports: 'src/exports',
    // 根入口要 child_process 拉起 helper，只给 Node；渲染进程只能加载可移植数据
    browserSafeEntries: ['contracts.ts'],
    environmentTable: 'ComputerEnvironmentVariables',
    hostPort: 'ComputerToolComputerApi',
    hostPortField: 'computer',
    layers: [
      // 工具：六个桌面控制工具的定义、分组与挂载
      ['ComputerTools.ts'],
      // 工具执行：可用性门禁、坐标解析、结果投影，经宿主端口 ctx.computer
      ['ComputerInputOperations.ts'],
      // 运行时：拉起 Python helper、JSON Lines 协议、按 id 关联请求
      ['ComputerSidecarManager.ts'],
      // helper 定位：按平台与资源根找脚本与自带 venv
      ['ComputerHelperLocator.ts'],
    ],
    toolDefiner: 'defineComputerTool',
    // 卡片与不变量登记是入口收口那一轮的事，这三份现在还不存在，照样登记，燃尽表里看得到
    card: 'MODULE.md',
    invariants: 'spec/invariants.md',
    acceptance: 'spec/acceptance.test.ts',
    status: 'migrating',
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
