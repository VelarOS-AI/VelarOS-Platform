# 仓库打包规则

- 临时核验 workspace tarball 时，使用 `bun run check:package-pack -- <包目录名>`，例如 `bun run check:package-pack -- browser`。
- `bun pm pack` 只打包当前工作目录，不接受包目录位置参数；仓库脚本与临时命令都不得从 workspace 根目录直接调用它。
- 打包目标必须是本次运行独占的临时子目录，不得直接使用 `/tmp`、`/private/tmp` 或系统临时目录根。
- 新增打包流程必须复用 `scripts/release/safe-package-pack.mjs`，保留超时、进程组回收和路径边界校验。

# 模块结构（interface / contract / impl / utils / exports）

已治理的模块登记在 `scripts/ownership/governed-modules.mjs`，方案见 `docs/architecture/module-ownership.md`。对这些模块：

- 不拆碎文件：一个文件一个职责，内容多没关系；不要为了整齐造出一堆只放一两个文件的目录。
- 全部工具定义在登记的工具文件里（`packages/system` 是 `src/impl/SystemTools.ts`），连同分组与挂载；定义工具的函数只在那里调用。工具改了要在差量报告里逐个点名理由与影响，人复核。
- 接口在 `src/interface/`，只有三个文件：`provides.ts` 产品面、`requires.ts` 注入面、`internal.ts` 包内部类的接口。只放带中文说明的类型声明，每个成员都写说明。改 provides 或 requires 等于改对外契约，要在差量报告里点名。
- 数据在 `src/contract/`：扁平，只放字段、类型、常量表，不许出现函数类型和方法，只引数据。可移植数据文件不 import 任何东西，整个就是 `./contracts` 入口。
- 实现在 `src/impl/`，扁平：一个类一个文件，文件名就是类名。每个类 implements `interface/` 里的一个接口；类的公开成员只能是接口里的，没有公开静态成员；私有方法只放用得到实例状态、没法提出去的公共逻辑。模块级函数只许是对外入口要的工厂。每个实现文件在登记表的 layers 里有层，下层不许引上层。继承 Error 的错误类不写接口、不出包。
- 纯工具函数在 `src/utils/`：扁平，按类别分文件；只放函数和常量，不放类、不导出类型、不存状态；每个函数上方一句中文说明写它做什么；只引 utils、数据与接口。
- 对外入口在 `src/exports/`，只转发。导出的类型只能来自 provides、requires 和 contract；导出的值只能是契约常量表或按公开接口标注类型的实例与工厂；类、utils 函数、内部接口不出包。公开签名用到的数据都导出，导出的数据都被公开签名用到。
- 注入只从 requires.ts 的口子进来，别处不留钩子；环境变量全部登记在可移植数据文件的环境变量表里。依赖只写在文件头，不用内联 `import('…')` 类型和动态 `import()`。
- 登记为渲染进程可加载的入口（`browserSafeEntries`），整条值引用链不许出现 Node 内置模块；`src` 下只有这五个目录。
- 验收测试不能破，改已有验收用例要在差量报告里说明原来的承诺为什么不对。每轮结束交差量报告；`bun run check:module-ownership` 必须绿。
