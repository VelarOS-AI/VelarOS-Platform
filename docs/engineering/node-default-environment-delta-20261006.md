# Node 默认执行环境差量报告

本轮先将 `eval/long-runtime-comparison` 快进合并到本地 `main`（`d3b6c5cd`），随后统一 Platform 与 Desktop 的执行环境。当前接入以包 README、公开 exports 和生成的模型合同为准。

## 当前组织方式

模型使用单一 `exec({code})` 入口执行 Node.js ESM，支持顶层 await。文件读写使用 Node 标准库，进程使用 Execa，业务数据处理使用 JavaScript。默认包从 `@velaros-ai/script` 的生产依赖分发，清单由 `NodeDefaultPackages` 统一提供，运行加载器与模型提示词共用此清单。

| 默认包 | 本轮安装版本 | 用途 |
| --- | --- | --- |
| execa | 9.6.1 | 进程、参数、标准输入输出与退出状态 |
| @vscode/ripgrep | 1.18.0 | `rgPath` 指向随包分发的平台搜索二进制 |
| globby | 16.2.4 | 文件匹配 |
| diff | 8.0.4 | 文本差异 |
| yaml | 2.9.1 | YAML 解析与序列化 |

工作区自己的 npm 依赖优先，由 Node 按其正常解析规则处理。默认包及其官方子路径（如 `yaml/util`）为独立工作区提供补充解析；损坏的本地依赖必须返回实际错误，项目的 exports 限制仍然生效。入口程序、保存的普通脚本和 Node 子进程共享默认包与已授权能力的加载入口。应用能力不能通过模块注册或聚合包注册覆盖默认包名。

Electron 发行版将默认包及其实际生产依赖闭包复制到 `resources/node-runtime`，保留对应平台的 ripgrep 二进制。宿主以可选 `packageDirectory` 指定独立 Node 能读取的普通目录；主执行与观察执行共用此配置。构建过程只复制当前安装的锁定版本，保留许可证并排除类型源码与 source map；文件哈希清单和真实导入检查在发行门禁执行。宿主 JavaScript 仍在 ASAR 中，Electron 的 RunAsNode 保持关闭。

`velaros:project` 仅在项目工作区装配，按需提供修改前核对、编码与换行保留、批量事务、差异检查和冲突撤回。事务承诺属于 project API，普通 `fs` 写入遵循 Node 语义。应用能力通过 `$VELAROS_HOST_DIR/index.json` 和逐操作声明发现，按需导入；默认提示只保留执行语义、工作目录、输出、能力目录入口和当前可用的领域提示。

## 合同迁移与清理

| 原合同或实现 | 本轮处理与影响 |
| --- | --- |
| 原生 `shell`、`node` 两个工具 | 统一为 `exec`，参数仍由正式 `NativeExecutionInput` 生成。完整响应验收、调用身份和持久回执配对继续成立。 |
| `velaros:files` | 删除模型模块、实现、模板、声明、生成登记及包导出。事务职责复用 project 的现有事务内核。Desktop 文件浏览器使用的本地搜索服务迁入 project。 |
| `velaros:shell` | 删除模型模块、四个操作及注册工厂。通用进程操作使用 Execa 官方 API。 |
| 宿主 `@velaros-ai/velaros/shell` 子路径 | 移至 `execution`。保留产品终端、PTY、进程树、环境、约束和沙箱所需的风险分类与审批实现；普通管道进程由 Execa 启动。 |
| `createShellNodeEnvironment` | 替换为 `createNodeExecutionEnvironment({host, ...})`，输出合同改为 `NodeExecutionOutput`。Desktop、沙箱、发布消费者与评测入口同步迁移。 |
| Node 宿主默认包目录 | `NodeCodeRunnerOptions` 与 `NodeExecutionEnvironmentOptions` 增加可选 `packageDirectory`，供 Electron 等宿主提供独立分发目录；省略时使用 Script 安装位置的生产依赖。模型接口仍是标准 import。 |
| `projectCapabilityPorts.shell` | 删除。项目权限由 Node 执行宿主承担，项目目录与事务由 project 承担。图片和演练沙箱端口继续沿用。 |
| 文本协议的 shell 控制段 | 删除。文本驱动提交 JavaScript；原生驱动提交 `exec`。历史 trace 的语言与回执解码保留，以便读取既有执行事实。 |
| 旧评测入口 | 删除仅依赖旧接口的 `standard-runtime-evaluation.mjs` 与 `native-tools-footprint.mjs`。当前 Harbor、长任务和 Desktop 接线脚本迁至新入口；历史报告与已冻结产物保持原样。 |

File 的三个模型操作与 Shell 的四个模型操作共七个从生成面退出。宿主类名中的 Shell 表示实际系统 shell 或终端职责，属于 execution 基础设施。QuickJS 不在当前依赖、装配和执行链中。

## 权限与验收承诺

Node 启动前由宿主审批整段源码，实际操作系统约束覆盖该进程及其子进程。Execa 内部命令与 `fs` 操作不会自动变成逐条 Kernel 调用；按需能力 RPC 仍逐次经过授权。取消、超时、输出截断、异常退出和清理未完成保留真实回执。macOS 约束继续报告实际的 partial 覆盖，Windows 专属行为需要相应平台验收。

- Runtime INV-88 改为单一 exec 的完整响应接纳，保留中断零派发、非法后续调用阻止前序副作用、取消恢复、回执绑定和跨轮持久化；INV-48 的持续目标完成门继续有效。
- Execution 保留原宿主相关不变量编号和行为测试。原 Shell 模型面专属承诺随模型模块退役，不把 Execa 调用包装成原有操作合同。
- Project INV-26 的 Shell 适配器承诺随该端口退出；INV-27 保留演练沙箱路径限制。文件事务的原子提交、版本冲突、撤回和取消覆盖继续通过 project 验收。
- Sandbox 的危险命令审批和进程约束继续使用 execution；Browser 文件处理说明与当前 Node 环境一致。

仓库零基线规范检查暴露的既有错误一并做等价修正：核心类型守卫、空值判断、条件字段构造，以及普通文本尝试解析 JSON 时的明确回退说明。冻结评测任务 JSON 的原始字节参与候选身份核对，因此与其他固定夹具一样排除自动格式化。

## 验证与收益口径

默认包验证使用真实 Node 和真实子进程，覆盖无本地依赖的临时工作区、保存脚本、子 Node、ripgrep 本机二进制、工作区依赖优先、损坏依赖报错、注册冲突和项目能力的注入范围。独立 tarball 安装验证包含五个默认包、NodeNext 消费者及浏览器安全入口；Desktop 使用随产品提供的 Node 验证执行接线。

定向回归已通过：Script 165 项、Execution 107 项（另有 6 项 Windows 跳过）、Project 与能力组合 694 项、Desktop 会话 46 项。最终 Runtime/Act 全组运行的 894 项中 892 项通过，两个失败分别是工具回执夹具遗留名称和可选字段存在性；修复后两组 199 项全部通过。默认 npm 包、子路径、两类注册冲突及项目注入边界均已通过。额外 Provider/MCP/计量 40 项、评测主线 34 项、能力组合 5 项和桌面/长任务评测脚本 16 项通过。初次失败保留在本轮验证日志中，结论以修复后的对应检查为准。

Desktop 完整 `bun run check` 和四个顺序类型分区通过；使用产品 Node 的默认包单项复验通过。Platform 的构建、类型检查、ESLint、格式、零基线代码规范、模块所有权、架构、声明生成、目录、README 示例、许可证、独立 tarball 消费者和平台代检查通过。

补充安装包验证：独立 npm 资源目录的五包加载、ripgrep 执行及文件变动拒绝通过；真实 Electron 开发启动与 ASAR 启动各通过一组，覆盖计算、宿主能力调用、程序错误、超时、启动前取消、运行中取消、保存脚本和 fork。ASAR 组使用应用携带的 Node，在空 PATH、RunAsNode 关闭的条件下验证，并确认原始开发 Electron 的 Fuses 没有改变。发行安全回归 26 项、发布流程约束 5 项通过，随后 Desktop 完整检查再次通过。本轮没有制作或发布新的签名安装包。

完整发布门禁仍有两项未通过：

- `check:dependency-security`：以同一审计源比较改造前 `HEAD` 锁文件与当前锁文件，在仓库既有两个忽略项之外分别为 29 与 30 项告警；唯一新增项为 globby → fast-glob → micromatch → braces 3.0.3 的 [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。2026-10-06 npm 的最新版仍为 3.0.3，上游公告列明暂无修复版本。此告警没有加入忽略清单，库没有被替换成自定义兼容层。运行中每段源码独占 Node 进程并受现有时限与内存预算约束，这不等于修复上游问题。
- `check:public-readiness`：两份既有 JSON 结果文件（`scriptact-long-runtime-results-20261004.json` 与 `scriptact-native-tools-results-20261004.json`）包含本机绝对路径。与改造前 HEAD 对照，两文件逐字未变。退役源码造成的 11 处历史链接已改为迁移前 Git 源码定位，历史测试成绩保持原样。

因此本轮报告功能与分发验证通过，不报告整个 `bun run check` 或发布门禁全绿。

已经验证的收益是入口从两个收敛为一个、七个自定义模型操作退出、五个标准包可直接使用、事务只有一个领域所有者。现有回归和独立安装验证证明接口及分发行为；本轮没有运行新的付费模型 A/B，不能据此宣称正确率、总费用或整题耗时改善。历史评测中的 Shell 调用计数仅对应当时的 Kernel 回执，新环境中的程序数应按执行记录统计，程序内 Execa 命令数不能由 Kernel 操作数推算。
