# 工作区与 Skill 组合改造

日期：2026-10-07。范围：Platform 与 Desktop 的运行时装配、Skill 目录、聊天选择及发行资源。

## 当前结构

| 场景 | 环境组成 | 资源绑定 |
| --- | --- | --- |
| 日常任务 | Node.js + 基础 npm 包 + 会话选择的 Skill | 会话工作目录 |
| 项目工作区 | 基础环境 + 宿主项目能力 + 会话选择的专项 Skill | 项目根、项目内核及宿主代码索引 |
| JS/TS 项目 | 项目环境 + jsts | 本轮 JS/TS 语言查询与专项 npm 依赖 |
| 浏览器工作区 | 基础环境 + 内置 browser + 会话选择的 Skill | 当前浏览器会话 |

基础 npm 包为 `execa`、`@vscode/ripgrep`、`globby`、`diff`、`yaml`。宿主按工作区资源配置项目事务、代码查询与通用能力。Skill 选择由 `skillComposition.select` 合并工作区默认项和显式选择，注册表通过同一份租约固定版本、公开依赖与授权。

`@velaros-ai/skill-jsts` 是独立的标准 npm 资产包，包含 `package.json`、`SKILL.md` 与精确版本依赖：

| 包 | 版本 | 用途 |
| --- | --- | --- |
| ts-morph | 28.0.0 | JS/TS 语义查询与重构 |
| prettier | 3.9.9 | 使用项目配置格式化 |
| jsonc-parser | 3.3.1 | 保留注释的配置局部编辑 |
| @ast-grep/napi | 0.45.3 | 语法结构搜索和改写 |
| @playwright/test | 1.63.0 | 网页测试 |

Agent 直接使用原包 API。包的实际版本、README、类型声明和实现入口可按需查询；说明正文通过 `velaros:skills.load` 读取。网页测试使用项目的测试配置，浏览器二进制按任务需要准备。

## 合同变化与影响

- `SkillRegistryOptions.builtins` 接收宿主信任的内置包目录。`SkillRecord.builtin`、`SkillSummary.builtin` 表示产品管理的来源；安装内容无法自行获得该身份。内置包通过产品更新，安装包使用原有安装、升级和删除流程。
- `BuiltinSkillNames` 登记 browser 与 jsts 的官方身份，运行时发现与 Desktop 发行核验共用这份清单。项目工作区的调用方通过 `createRuntime({ project })` 配置项目能力，默认 Skill 集为空。
- `SkillContribution.hostCapabilities` 声明宿主绑定需求；字段保持可选，既有安装收据继续有效。`velaros:*` 表示宿主模块，`project:language:*` 表示语言扩展。声明经会话选择形成授权，资源由宿主注入。
- `SkillCapabilityModuleOptions.hostModules` 提供当前资源的实现；`createRuntime({ skills })` 装配所选 Skill 声明的宿主模块与第三方能力。缺失绑定明确报错；外部入口仍在受控 Node 子进程运行。
- 同一宿主模块可被多个所选 Skill 共用。执行、准备、观察和核对均重新检查授权，至少一个固定版本的来源有效才可继续。第三方导出入口冲突与公开 npm 包版本/内容冲突仍在组合时拒绝。
- `createProjectCodeQuery` 支持本轮固定的语言集合。项目事务与代码查询入口由宿主按项目根直接装配，语言 Skill 决定启用哪些语言服务。`velaros:images` 是宿主直接装配的通用能力，项目空间通过项目内核约束路径，系统与浏览器空间使用会话本机端口。宿主注入的代码图谱后端保持有效。SDK 省略语言参数时保留原有默认语言服务，现有独立调用可继续工作。
- 基础运行时的 `NodeDefaultPackages` 固定为五个通用包。专项依赖由选中的 Skill 公开；工作区已有 npm 依赖继续按 Node 解析规则优先使用。仅列出 Skill 不解析其可选依赖，缺失依赖在选择该包时报告。

## Desktop 行为

项目工作区默认 Skill 集为空，项目能力由宿主提供；浏览器工作区默认选择 browser，默认项在聊天框「+」内标明来源。会话附加 Skill 单独保存在草稿与排队消息快照中；工作区切换重新计算默认项。JS/TS 开发在「+」中选择 `@velaros-ai/skill-jsts` 后发送。

宿主按工作区描述中的项目根绑定启用项目事务与代码查询。浏览器会话可携带本地工作目录，该目录供 Node 和本机图片端口使用；项目能力仍由工作区绑定类型决定。

设置页每张卡片展示名称、版本和简介，官方包在标题右侧显示“官方”标签；安装包可通过原有删除图标管理。内置版本由产品管理。已提交的显式版本保持固定，升级后重新选择版本。

发行资源包含 `node-runtime/node_modules` 的基础依赖和 `node-runtime/skills/<id>` 的 Skill 资源及独立 npm 依赖。资源清单核对全部文件；类型声明在经过资源核验的 npm 目录内可读，普通 TypeScript 源文件和 source map 继续受发布门禁约束。临时 tarball 检查逐个核对嵌套 Skill 资源。

## 验收变化

- Skills INV-5 明确区分公开 npm/第三方入口冲突与共享宿主绑定；共享宿主授权由 INV-7 覆盖。
- Skills INV-7 覆盖内置与安装包共同选择、默认项合并、缺少绑定、专项依赖隔离、共享授权撤销及缺失可选依赖。
- Runtime INV-56 明确项目事务由宿主配置装配，空 Skill 项目环境具备项目文件和通用看图能力；图片路径继续由项目内核约束。
- Runtime INV-87 将开发工具的公开范围归入所选 jsts，并验证宿主项目配置与六种 Skill 组合；空 Skill 的项目会话可读取项目文件，jsts 在项目会话启用语言查询、在普通会话公开 npm 包，宿主关闭项目能力时维持该边界。项目组合继续验证通用看图和项目路径约束。
- 项目事务核对、沙箱、Kernel 效果记录、安装原子性与后台任务租约继续沿现有边界执行。

## 验证证据

- Platform 拓扑构建、`check:module-ownership`、`check:script`、`check:act-catalog` 和本轮 TypeScript 修改的 lint 通过。
- Platform 运行时定向回归 2 项通过：覆盖六种宿主项目配置与 Skill 组合，并实际核对项目文件读取、代码图谱、语言查询、图片尺寸与交付、越界路径拒绝以及 npm 依赖范围。Skills INV-7 定向验收 4 项通过。
- `bun run check:package-pack -- velaros` 通过，核对独占临时目录中的真实 tarball 与 Skill 资源。
- Desktop 对话运行时检查 52 项通过，包含日常、项目、浏览器及带本地目录的浏览器会话，实际验证图片进入下一次模型请求和项目能力的工作区边界。
- Desktop Skill 选择测试 2 项、发行依赖检查 1 项、四分区类型检查及本轮 TypeScript 修改的 lint 通过。发行检查同时核对资源清单与篡改拒绝。
- 真实 React 设置组件与产品样式在独立无头浏览器中核对中英文页面：browser、jsts 和用户安装包各占一张紧凑卡片，官方标签位于标题旁，用户安装包带卸载操作，页面无运行错误。

这些证据覆盖本轮宿主装配、Skill 组合、发行资源和设置展示。模型任务成功率和成本变化需要独立的真实模型对照评测。

## 已知全库检查状态

Desktop `bun run check` 通过前置结构检查和 52 项对话运行时检查后，在 lint 阶段报告其他进行中改动的 `useChatStreamingFinalize.ts`、`devElectronSmoke.test.mjs` 和 `chatUsageTelemetry.test.ts` 的 import 排序问题。四分区类型检查与本轮 TypeScript 修改的 lint 已单独执行通过。

## Desktop 与 Workbench 宿主接入核对

两个应用当前都通过公开包入口链接同一份 Platform 构建。Desktop 的项目根绑定、空默认 Skill 集、通用图片端口及官方资源清单已经与上述合同一致。

Workbench 的项目会话通过 `createRuntime({ workspace: root, project: { code: true, images: true } })` 直接配置宿主能力。IDE 的语言查询与五个代码工具由宿主预置，Node 环境和发行流程共用 `workbenchNodePackages.json`；发现读取元数据，实际导入使用原包实现，项目安装版本优先。本轮沿用这些公开合同，补充真实图片交付和项目路径边界验收，并把 `docs/workbench-prompt-audit.md` 的能力来源说明对齐实际宿主装配。

接入核验结果：

- Desktop 浏览器和四种图片场景的运行时定向回归 6 项、Skill 选择 2 项通过。
- Workbench 会话运行时 15 项通过，实际覆盖项目编辑、JS/TS 诊断、五个代码工具、图片交付、路径限制、会话协作与进程回收。
- Workbench 类型、产品边界及包链接清单检查通过。
- Workbench 在独占临时目录准备真实发行依赖，以随产品分发的 macOS arm64 Node 验证 10 个公开 npm 包、npm 安装器及 3,282 个资源文件，并验证资源篡改拒绝。
- Platform `check:module-ownership` 与 Workbench 回归文件格式检查通过。

## browser Skill 跨工作区接入

browser 的说明与简介明确其在日常、项目和浏览器工作区的用途。浏览器工作区默认加载；日常与项目会话通过聊天框「+」显式选择，固定版本租约为三类工作区提供同一套 browser、devtools 和 CDP 合同。

Desktop 宿主按需为日常和项目会话连接现有 Chrome，或通过 Platform 启动使用独立配置的浏览器。每个会话使用自己的标签页；后续导航复用标签页，页面关闭后按需重新打开。浏览器工作区的页面来自内置浏览器。实际启动失败保留底层错误码与原因，并恢复准确的站点状态。

本轮调整的是 Desktop 的浏览器资源供应策略及内置说明，公开操作签名和 Skill 授权合同保持一致。相关说明、宿主回归和跨工作区集成用例共同描述当前行为。

核验结果：

- Desktop 会话运行时 56 项通过，新增三类工作区的真实 Node/Kernel 接缝执行分别调用 browser.open/state、devtools.zoom 与 cdp.send，并核对下一帧页面信息及工作区身份；页面端口使用受控测试实现。
- Desktop 浏览器宿主 11 项、Skill 选择 3 项通过；覆盖按需连接或启动、标签页复用、关闭后重开及失败状态。
- Platform 外部浏览器/CDP 14 项通过，使用模拟进程和 WebSocket 覆盖启动回退、标签页隔离、连接复用与资源回收；Platform 构建和模块所有权检查通过。
- Desktop 四分区类型检查及本轮修改文件的 lint 通过，定向格式化与两个仓库的差异空白检查通过。
- Desktop 全量门禁通过运行时与前置结构检查，lint 仍被上文记录的三处已有 import 排序问题阻断。
