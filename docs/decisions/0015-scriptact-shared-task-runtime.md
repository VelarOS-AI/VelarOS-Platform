# 0015: ScriptAct 主干使用共享任务帧与统一模块合同

- Status: accepted（外层 `script.run`、有界上下文规划器与 off/shadow 档已被后续实现取代，见文末「后续」）
- Date: 2026-09-19
- Owners: Kernel、Context、Script、Agent、Model、Velaros

## 动机与决定

以 [Platform 统一执行架构](../architecture/platform-runtime.md) 为正式主干。主模型决定行动与观察需求，有界上下文规划器选择证据，Runtime 负责真实读取与 ModelView 发布。所有模型步骤共用用户目标、任务状态、回执、存储和预算。

Velaros `createRuntime` 默认 active。外层统一 `script.run`，支持自动保存的新源码与已保存 sourceRef；内层能力由宿主通过 `createCapabilityModule` 装配既有操作。12 个领域模块的声明、schema、效果及模板均从现有接口生成，Kernel 在注册与调用边界核验。

新增进度报告区分脚本、输出、证据和图像变化；代码与证据使用 Core 的同一行差量算法。图片使用 Kernel 的中立合同贯通真实回执、Script、Context 与模型编译。

## 所有权和边界

Core 持有通用差量；Kernel 持有中立模型/操作合同、派发与生命周期；Context 持有原始存储、共享任务帧、物化与进度；Script 持有检查和执行；Agent 持有循环与 ProviderRequestCompiler；Model 持有供应商适配；Velaros 持有领域实现和统一装配。

空间和原生资源由宿主注入。真实路径、版本、危险命令及领域事务边界继续由原实现承担，遵循 ADR 0009。

## 权衡

模块目录在 Runtime 生命周期内固定，资源变更以新实例/代际装配；这使合同、调用身份与恢复结论始终可验证。
未知写入保持未决，领域缺少核对能力时不会自动重试。进度信号只辅助模型判断，硬预算负责限制无效循环。
生成合同承担结构校验，业务约束留在领域实现。图像预算采用保守估算，供应商优化需要实测。

## 迁移

已有领域实现和端口原样接入工厂；宿主不再逐方法维护模型声明和调用表。新主循环通过 Velaros 根入口装配。
兼容测试显式配置 off；旧入口在其已发布合同下继续验收。sourceRef 为当前会话的脚本记录 ID，每次运行产生新的执行身份。
已有持久任务缺省 step=0；旧视图缺少 progress 时重建；同一目标的重启保留用量、进度和上一份视图。

## 验证与回退

用无真实模型的集成测试验证 v1 → v2 → 新证据视图、94 操作严格注册、实际 Project/Files/Image 能力、脚本重启复用、独立差量、停滞提示及 AI SDK 图像协议。
沿用现有领域和主干回归、生成一致性、依赖及模块所有权门。
迁移回退可显式选择 off/shadow；持久回执和不可变原文继续保留。生产认证、真实供应商质量与原生环境测试分别报告。

## 后续（2026-09-26 补记）

主干仍然成立：所有模型步骤共用用户目标、任务状态、回执、存储和预算；领域能力由宿主经 `createCapabilityModule` 装配，声明从现有接口生成，Kernel 在注册与调用边界核验；sourceRef 是本会话的脚本记录，每次运行产生新的执行身份。
下面几处已被后续实现取代，现行设计以 [运行主链](../architecture/platform-runtime.md)、[文本协议](../architecture/scriptact-text-protocol.md)、[Agent 与 Act](../architecture/agent-act-consolidation.md) 和 [长程上下文](../architecture/long-running-context.md)（[ADR 0017](0017-long-running-context.md)）为准。

- **外层入口。** 「外层统一 `script.run`」指模型每轮交一份结构化提交，342be1f2 时是按 JSON schema 约束的整份 `script_turn` 响应。2026-09-22 起（71fa202a）改成纯文本帧协议：模型输出纯文本，程序段用每帧随机标记框出（`blobs` / `observe` / `execute` / `done`），供应商请求里没有业务工具表，也没有 JSON responseFormat。宿主的 `session.script / observe / execute` 仍在，走同一套检查、发布与运行。
- **上下文规划器。** 「主模型决定行动与观察需求，有界上下文规划器选择证据」不再成立：BoundedContextPlanner 及其独立 JSON 模型循环已在 71fa202a 删除。主模型自己在 observe / execute 程序里读取证据；要检索时在 execute 里调 `velaros:search`，搜索与上下文整理都是跑同一套 ScriptAct 循环的独立会话；容量按剩余轮数封段，封段不调用模型。现在代码里叫 planner 的两处都不是它：agent 包的 `ContextPlanner` 是 ADR 0017 的容量规划（校准估算、算剩余轮数）；context 包低层物化合同里可选的 `ContextPlannerPort`，运行时装配显式不传，只有该包自己的测试在用。
- **off / shadow。** `createRuntime` 已经没有 active / off / shadow 这几档，「兼容测试显式配置 off」「迁移回退可显式选择 off/shadow」随之作废。
- **所有权。** ProviderRequestCompiler 现在归 Model（`model/src/impl/requests/`），Agent 持有 ActLoop 与运行控制。
