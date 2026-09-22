# ADR 0016 — 项目语言服务与命令行归属

日期：2026-09-22。状态：已采纳。

## 背景

`development` 的语言查询、JS/TS 与 Python 服务、外部 LSP、TypeScript 项目池都为项目代码查询服务。它依赖 project 的查询契约，单独发行增加了包之间的版本和装配边界。CLI 的默认命令集合只有 `terminal`，本仓和其他产品没有它的实际调用方。

## 决策

语言服务整体归入 `@velaros-ai/velaros/project`，包括实现、工具函数、契约、验收和测试。入口沿用 project 与 project/contracts，产品按需要装配 `createProjectCodeQuery`。只读语言端口仍是内核的三个读方法，代码图谱由宿主提供。实现内部使用相对引用，以 project 为唯一所有者。

`@velaros-ai/cli` 归入 VelarOS-Termel 的 `packages/cli`，包名、`velaros` 命令、信封、错误码、参数转交和退出码承诺保持一致。Termel 使用自己的已发布 Core 版本，包独立构建并随 Termel 工作区检查；模块治理和 9 条不变量同行。

Platform 的八个包是 core、kernel、model、context、script、agent、velaros、agent-lab。Core 提供跨域基础，Kernel 提供执行契约与回执，Model 编译并发送模型请求，Context 规划上下文，Script 负责代码门，Agent 推进任务，VelarOS 持有领域能力与装配，Agent Lab 提供评测。UI 归 VelarOS-UI，document-renderer 归 Desktop。

## 迁移与验收

语言调用方将 `@velaros-ai/development` 改为 `@velaros-ai/velaros/project`，数据引用改为 `@velaros-ai/velaros/project/contracts`；本仓的消费夹具和集成测试已更新。产品各自接入已发布版本。

Project 的原不变量编号保持稳定；原语言服务 INV-1～INV-11 纳入为 Project INV-30～INV-40，原断言保留。Node 实现与可浏览器加载的 contracts 继续由模块治理验证。发布拓扑由当前八个包生成；`velaros` 命令归 Termel 的发行清单。
