// 模块结构登记：哪些包已进入治理，工具、契约、实现、对外入口各放在哪。
// 方案正文见 docs/architecture/module-ownership.md；本文件是门禁的单一来源。
//
// 字段：
//   directory       相对 packages/ 的目录
//   name            包名
//   toolsFile       工具文件（相对包根，没有工具的包不填）：全部工具定义都在这一个文件里，外加它们的分组与挂载。人最先看的地方，改了要在差量报告里点名
//   contract        数据契约目录：扁平文件，只放数据（字段、类型、常量表），不许出现函数类型和方法
//   portable        可移植数据文件：不 import 任何东西、不用 Node 专属类型，浏览器也能用；`./contracts` 入口就是它
//   interface       接口目录：只放带中文说明的类型声明，文件就是下面登记的几个
//   publicInterfaces   公开接口文件：provides 是产品面（交给外面的整件能力），requires 是注入面（宿主要塞进来的东西）；
//                   这两个文件里的每个声明都从根入口导出，对外导出的值也只能按它们标注类型
//   internalInterfaces 内部接口文件：不属于某个类的内部接口（utils 函数的选项、工具定义的入参），不出包，公开接口也不许引用它；
//                   包内部类的接口不在这里，写在类文件里、紧挨在类的上方
//   impl            实现目录：扁平，不分子目录。一个类一个文件，文件名就是类名（工具文件除外，它不放类）；
//                   每个类实现一个接口（公开的在 interface/，内部的就写在类上方一起导出），公开成员不超出接口，私有方法必须用到实例状态
//   utils           纯工具函数目录：扁平，按类别分文件；只放函数和常量，每个函数上方一句中文说明，只引 utils 与契约
//   exports         对外入口所在目录，package.json 的 exports 指向这里编译出来的文件
//   browserSafeEntries  会被渲染进程加载的入口（exports 下的文件名）：整条引用链不许出现 Node 内置模块
//   environmentTable    可移植数据文件里登记环境变量的常量表名
//   hostPort            注入面里的宿主端口接口名；端口只放工具真会调的方法，门禁按工具文件核对
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
    portable: 'system.ts',
    interface: 'src/interface',
    publicInterfaces: ['provides.ts', 'requires.ts'],
    internalInterfaces: ['internal.ts'],
    impl: 'src/impl',
    utils: 'src/utils',
    exports: 'src/exports',
    browserSafeEntries: ['contracts.ts'],
    // 可移植数据文件里的环境变量表：代码里出现的每个 VELAROS_* 名字都要登记在这里
    environmentTable: 'SystemEnvironmentVariables',
    // 宿主端口：注入面里工具经 ctx.system 调的那个接口；它的每个方法都必须有工具在调，没人调的不许留
    hostPort: 'SystemToolSystemApi',
    // 实现文件的分层，从上到下；上层可以引下层与同层，下层不许引上层
    layers: [
      // 工具：六个工具的定义与挂载
      ['SystemTools.ts'],
      // 宿主：宿主端口的本机实现
      ['LocalSystemKernel.ts'],
      // 能力：命令、受管子进程、shell；文件操作与搜索
      [
        'SystemCommandRunner.ts', 'SystemSandboxes.ts', 'SystemCommandPolicy.ts', 'SystemShellResolver.ts', 'SystemProcessManager.ts', 'SystemManagedProcess.ts',
        'SystemOutputDecoder.ts', 'SystemFileOperations.ts', 'SystemFileHistory.ts', 'SystemGlobalSearch.ts', 'GitIgnoreSystemSearchPolicy.ts',
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
    directory: 'platform',
    name: '@velaros-ai/platform',
    // 没有工具：不登记 toolsFile、toolDefiner、hostPort
    contract: 'src/contract',
    portable: 'platform.ts',
    interface: 'src/interface',
    publicInterfaces: ['provides.ts'],
    internalInterfaces: [],
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
