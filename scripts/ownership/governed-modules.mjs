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
