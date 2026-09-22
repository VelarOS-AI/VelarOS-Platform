# 声明式观察输出接入差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

## 问题和最终行为

持续观察采用源码声明的分块输出。整理工具能调整展示范围和预算，将规则写回同一观察源码版本链，并在当前轮重新展示已归档结果。外部资源不因整理而重读，主线能看到采集版本、展示版本及原因。

## 实际接入点

| 层 | 文件与责任 |
| --- | --- |
| Script 原语 | script/src/utils/standard.ts、ScriptPackageCompiler：唯一 output 类型声明进入实际模型检查面 |
| 隔离执行 | script/bin/script-child.mjs、NodeSubprocessCodeRunner：调用时快照、受限 IPC 和失败保留 |
| 原始结果 | CodeSurfaceSession、types/output.ts、types/outcome.ts：原值、预览和图片分开 |
| 源码与呈现 | ScriptOutputs、output-source/output-render/output-capture：真实符号识别、受限编辑、类型化预算、摘要指纹 |
| 正式上下文 | ProgramContext、ContextMemory、RecentContext：归档召回、重新展示、图片装配、逐块变化基线、历史去重 |
| 整理支线 | ContextMaintenanceState、ContextMaintenance：父快照输出目录、版本校验、受限源码发布、原值补丁解析 |
| 模型使用 | RuntimeSession 指令、programs-template.js、script README：参数、限制、引用和执行语义 |

## 对外契约

- output 增加可选 options，增加 output.configure。普通 output(value) 保持可用。
- ScriptOutputsApi / scriptOutputs 提供 describe/edit/project/hash；ScriptOutputLimits 与对应数据类型对外导出。
- CodeRunOutcome / CodeSurfaceOutcome 增加原始输出、原始导出、命名图片映射和执行计量。原 result 的有界预览语义保留；结构化工具交付改为消费原始值，显式 output 对象里的 default 字段保持业务数据语义。
- ContextPatch.observation 改为 sourceRef + config/outputs/summaries。持久的观察展示规则归观察源码所有。
- ScriptProgramVersion 增加 presentationOnly/reason，标明自动整理。
- 没有新增世界能力和递归模型工具入口。Agent Loop、Kernel 权限、Storage、ProviderRequestCompiler 继续复用。

## 验收变化

`context-maintenance.test.mjs` 原用例只检查隐藏的 maxChars 呈现策略，现在检查 config.maxChars 被写入新观察源码，后续新结果继续遵守它。原承诺的“每轮刷新、可召回、容量受限”保留；源码版本因显式发布而改变是新契约的必要行为。

新增引擎和集成验收覆盖快照不可变、异常/超时部分输出、重复 key、raw 上限、JSON/列表/代码边界、摘要失效、原生图片、AST 越权、CAS 原子性，以及独立整理工具修改源码后无额外观察执行。

## 实际验证

- Script 引擎与验收：73/73 通过，其中新增 output 用例 14 项。
- Act runtime、system、search、agents 的 Node 集成回归：251/251 通过，其中新增输出上下文集成用例 9 项。
- 结构化工具交付的最后调整后，另复跑输出上下文、整理工具和搜索合同：25/25 通过。
- Script / Velaros 构建及类型检查通过。
- module-ownership、script、act-catalog、agent-arch、agent-public-api、lockfile-consistency 门禁通过。
- Script 与 Velaros 使用仓库安全入口完成临时打包核验；改动路径的 git diff --check 通过。

集成测试使用真实 QuickJS 隔离执行器、Kernel、SQLite ContextStorage 和正式主循环。独立整理工具端到端记录为：第一轮观察读取 1 次、整理模型调用 1 次、主模型调用 1 次；修改后的展示规则进入主请求且观察没有重跑。第二轮累计观察读取 2 次、整理调用仍为 1 次、主模型调用 2 次，源码变化基线已推进。

模型响应来自确定性测试驱动；线上模型对观察范围的选择、摘要保真与长期任务成本尚未做真实 API 评测。

## 已知边界

动态 options、函数内部输出和附属模块里的输出可执行，自动源码编辑只管理主源码顶层的字面量声明。展示限制不降低第一个参数的采集成本；改变采集范围由主线通过已有脚本编辑入口完成。摘要正确性不能由指纹验证代替。原生图片和完整请求仍受模型最终预算检查。

本次不提交或推送。变更前快照位于本机临时目录 `observe-output-before-irjerph_`，用于区分已有 WIP。
