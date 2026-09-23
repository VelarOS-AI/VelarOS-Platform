# 仓库打包规则

- 临时核验 workspace tarball 时，使用 `bun run check:package-pack -- <包目录名>`，例如 `bun run check:package-pack -- browser`。
- `bun pm pack` 只打包当前工作目录，不接受包目录位置参数；仓库脚本与临时命令都不得从 workspace 根目录直接调用它。
- 打包目标必须是本次运行独占的临时子目录，不得直接使用 `/tmp`、`/private/tmp` 或系统临时目录根。
- 新增打包流程必须复用 `scripts/release/safe-package-pack.mjs`，保留超时、进程组回收和路径边界校验。

# 代码格式

- 代码格式由 Prettier 统一，配置与 Desktop 相同（`.prettierrc`）。改完代码运行 `bun run format`；`bun run check` 里的 `check:format` 会拦下没格式化的文件。
- 生成物（`contract/surface.ts`、`baselines/`）、模型面代码模版、vendor、测试夹具、`docs/` 与 Markdown 不参与格式化，见 `.prettierignore`；生成物的版式由生成器决定。
- 检查脚本与 lint 指令不能依赖源码排版：判断 import、类型等结构用语法树，`eslint-disable-next-line` 紧贴它要管的那一行。

# 错误

- 产品代码里抛的错都从 core 造（`@velaros-ai/core/error`）：`new AppError(code, message)`；要挂 `effect` 这类调用方直接读的字段用 `AppError.withFields(code, message, fields)`；取消与超时用 `createAbortError` / `createTimeoutError`。不直接 `new Error`，`check:error-construction` 按语法树核对。
- 错误码先用通用码（VALIDATION、NOT_FOUND、CONFLICT、CLOSED、UNAVAILABLE、CANCELLED、TIMEOUT、LIMIT、PROTOCOL、PERMISSION、INVARIANT），领域要让程序分支时再给专属码。
- 例外只有检查脚本里登记的几处（core 的错误模块、不依赖 core 的 agent-lab、整段注入 QuickJS 隔离堆的 output-capture），每条写明理由。

# 模块结构与所有权

以 `scripts/ownership/governed-modules.mjs` 的逐模块登记、包清单 exports 和实际检查器为准；完整规范见 `docs/architecture/module-ownership.md`。

- 不拆碎文件：一个文件一个职责，不为整齐创建只装一两个文件的目录。types/impl/utils 文件较多时可按域分组，每个子目录至少直接包含三个源文件；登记为单文件的 types/utils 保持单文件。
- 所有治理模块统一使用 `contract/types/impl/utils`。普通包源码根为 `src/`；能力单元直接以登记的 `unit` 目录为源码根，Velaros 不额外套 src；core 的底层单元住在 `src/<单元>/`，登记 `root` 指明源码根。
- 合同与数据：`contract/provides.ts` 登记产品面，`requires.ts` 声明宿主注入面，`constants.ts` 放公开常量；代码面能力可有生成的 `surface.ts`。类的 API 写在类上方，公开 API 经 provides 登记。`types/` 只放类型，公开签名用到的类型从入口导出；可移植数据不得带行为或 Node 类型。
- `impl/` 一类一文件，文件名与类名一致，公开成员由接口控制；私有方法用于实例相关逻辑，纯函数进 utils。实现文件必须登记 layers，下层不得依赖上层。utils 放有中文说明的纯函数与常量，不放类、类型声明或可变全局状态。
- 模型能力按当前 ScriptAct 链路维护。给模型的合同一律由 TS 操作接口生成，不手写 schema：领域能力与 Act 各职责组都在登记的 surfaceFile（操作接口所在的 `impl/*Operations.ts`）上用 `@AgentView` 写模型文档、`@OperationEffect` 写效果、`@OperationModes execute` 标只能在 execute 里用的写操作，由 `scripts/script/surfaces.mjs` 和生成器写出 `contract/surface.ts`（声明、派生 schema、版本号与模板）；`impl/*Module.ts` 只把生成的模型面与实现绑成 Kernel 模块（宿主上下文、读取登记、效果核对），由 Runtime 装配。标准模块 `velaros`、`velaros:program` 同样由 script 包的 TS 接口生成。若模块登记 toolsFile/toolDefiner，则遵守该模块的集中定义检查。
- 自管理能力集中在 `packages/velaros/act/system`，模型经 `velaros:system` 使用 modules/memory/store；运行装配在 act/runtime，搜索在 act/search，子任务与交互在 act/agents。业务能力在 files、project、browser 等同级能力单元。目录、宿主包子路径与模型 import 名称分别按实际映射说明。
- 模型可调用操作必须有生成的声明、效果声明、发现内容和使用模板。入参的数值上限写进 `@AgentView` 文档，数字取自所属单元的常量表，入参核对引用同一份常量，验收核对两边一致；派生 schema 只管形状。领域模板在能力单元根，Act 模板在职责组根；生成物不能手改。相应修改运行 `generate:script` / `check:script`、`generate:act-catalog` / `check:act-catalog`，需要读取构建结果的命令先构建所属包。
- 入口文件只转发，与 package.json 的 exports 及 dist 目标对应；普通包、能力单元和登记为 packageEntry 的根入口按各自映射处理。公开面由合同控制，实现类、内部接口和 utils 不作为公开 API。新增子路径必须有能力边界或运行环境边界依据，不增加同一职责的重复入口。
- 注入集中在 requires.ts。环境变量按所属模块的常量表和 environmentPrefixes 登记。依赖优先使用文件头静态导入，不用内联 import 类型；源码动态 import 仅允许登记的 lazyImports 目标及加载文件，bin 启动壳按自己的运行边界处理。
- browserSafeEntries 的完整值依赖链不得加载 Node 内置模块。能力单元的 spec/test 和登记的 assets 按各自用途管理；不要把非源码资产混进实现分层。
- 每个模块只有模块根目录的一份 README.md（规范见 `docs/architecture/module-readme.md`）：标题下一两句、`## 用法`（能照抄的最小示例，`check:readme-examples` 按真实类型检查）、`## 入口`（列全公开子路径）、可选 `## 约定`；导出清单、目录结构、依赖、不变量条数不写进文档。
- 验收承诺、README、invariants、生成声明和模板必须一致。修改公开合同或模型操作时，在差量报告逐项说明理由与影响；改变已有验收承诺必须解释。每轮交付差量报告，`bun run check:module-ownership` 必须通过。
