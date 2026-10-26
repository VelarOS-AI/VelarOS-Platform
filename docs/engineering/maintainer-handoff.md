# Platform 维护交接指南

换机或接手维护时，先恢复可构建的源码，再沿合同定位问题。本指南保存跨会话容易丢失的工程经验；接口和约束以当前仓库中的可执行合同为准。当前验证边界见[测试与平台支持](testing.md)，历史工作状态见 [2026 年 10 月交接快照](handoff-state-20261015.md)，评测经验见 [ScriptAct 评测与故障诊断](scriptact-evaluation-lessons.md)。

## 恢复开发环境

从官方仓库获取需要维护的分支，首先确认 checkout、提交和工作区状态：

```sh
git clone https://github.com/VelarOS-AI/VelarOS-Platform.git
cd VelarOS-Platform
git rev-parse --show-toplevel
git status --short
git branch -vv
```

历史 IDE 会话中的工作目录曾指向旧位置或外层目录。路径应从当前 Git checkout 推导；共享包的真实来源还要核对依赖链接。

工具版本以根 [package.json](../../package.json) 和 [开发要求](../../CONTRIBUTING.md) 为准。交接时 Bun 为 1.3.13，完整工作区含 JS/TS Skill，要求 Node.js 22.15 或更新版本；默认 SQLite 适配器单独要求 22.13 或更新版本。注册表配置使用 `NODE_AUTH_TOKEN` 环境变量，新机器需要具备相应 GitHub Packages 读取权限的凭据。

```sh
bun install --frozen-lockfile
bun run build
bun run check
```

当前公开链接以 bun run check:public-readiness 的结果为准。旧交接快照保留当时的失败记录，不作为当前失败清单；Windows 与 Bun 的运行差异、测试资源清理顺序见[测试指南](testing.md)。

源码拉取后立刻出现依赖缺失，先核对冻结安装是否完成。链接包更新后消费者仍表现为旧接口，先核对它实际加载的 `dist` 是否来自新构建。消费仓的源码检查与独立安装消费验证承担不同职责，两者都要覆盖公开 API 变更。

## 找到正确的所有者

定位顺序是 [模块登记](../../scripts/ownership/governed-modules.mjs)、包清单 `exports`、所属单元的 `contract/provides.ts` 和 `contract/requires.ts`，再进入实现及验收。完整规范见 [模块结构与所有权](../architecture/module-ownership.md)。

| 维护对象 | 所有者与边界 |
| --- | --- |
| 通用错误、文本文件、路径等基础能力 | Core；领域状态与产品编排由其上层负责 |
| 操作合同、调用、权限与回执、宿主中立传输 | Kernel；同一套合同支持进程内组合和可选宿主进程 |
| 持久运行控制与子任务监督 | Agent；协议解码、执行和上下文准备通过端口注入 |
| 输入原文、不可变证据、任务状态与上下文投影 | Context；保留原文身份与真实覆盖，展示预算和存储事实分别处理 |
| 模型请求编译、供应商适配与用量 | Model；最终发送的请求与供应商回执是诊断依据 |
| JavaScript 程序验证和隔离执行 | Script；程序结果、stdout、调用回执分别有自己的合同 |
| Runtime 装配与领域能力 | Velaros；Act 的 runtime、system、search、agents 各有职责，进程基础设施在 execution |
| 原生资源、产品策略、UI、存储根和发布 | 产品宿主；Desktop、Workbench、Termel 等通过公开 API 消费 Platform |

Platform 是多个 Agent 产品复用的基础。跨仓库问题优先修共享机制的所有者，再验证消费者适配；产品里的重复实现容易使后续产品继承不同语义。共享 UI 在 VelarOS-UI，CLI 在 VelarOS-Termel，Document Renderer 在 VelarOS-Desktop。当前包清单以根 `velaros.domainPackages` 为准，旧记录中的包数量和历史包名只用于定位历史。

宿主包子路径与模型 import 名称面向不同调用方。例如宿主从 `@velaros-ai/velaros` 导入 `createRuntime`，模型通过 `velaros:system` 使用自管理能力。新增公开入口应对应实际能力或运行环境边界。

## 修改公开能力

模型操作从所属 TypeScript 操作接口生成。先在登记的 `surfaceFile` 中更新操作签名、`@AgentView`、`@OperationEffect` 和执行模式，数值限制引用所属常量表；实现、验收与模板同步更新。详见 [仓库规则](../../AGENTS.md) 和 [操作面登记](../../scripts/script/surfaces.mjs)。

```sh
bun run generate:script
bun run build
bun run generate:act-catalog
bun run check:script
bun run check:act-catalog
bun run check:module-ownership
bun run check:readme-examples
```

这些命令用于相应合同变更，执行前核对生成器需要的构建输入。源码格式修改后运行 `bun run format`；Markdown、模型模板和生成物遵循各自的维护方式。产品错误使用 Core 的 `AppError`、`createAbortError` 和 `createTimeoutError`，调用方需要直接读取的字段通过 `AppError.withFields` 保留。

入口变更后沿清单、生成声明、基线、模板、测试、README、锁文件以及消费者检查传播。仅所有者自身构建通过，仍可能留下调用方导入错误或安装包缺件。每轮差量说明应写清行为、所有权、公开合同影响和验证范围。

## ScriptAct 的日常结果表达

执行期间用短 `console.log` 查看局部进展，最终结构化结果用 `export default` 返回所需字段。只含默认导出时，结果直接取默认值；有命名导出或混合导出时，结果是导出名称组成的对象。`export default await ...` 沿用 ESM 顶层 await 语义。实现入口是 [node-program.ts](../../packages/script/src/utils/node-program.ts)。

```js
console.log({ inspected: rows.length, preview: rows.slice(0, 2) });
export default { count: rows.length, selected: rows.slice(0, 10) };
```

日志、返回值和错误都有容量限制。先缩小诊断数据，再决定展示字段；错误消息用于描述故障。完整数据通过正式原文和结果读取合同获取，保留引用和覆盖信息。

## 联调与发布

正式消费者登记在 [platform-consumers.json](../../scripts/release/platform-consumers.json)。本地链接能验证源码集成，交付前还要检查包的实际文件、声明、依赖和消费者解析结果；操作步骤见 [消费者更新](platform-consumer-updates.md)。

临时 tarball 核验使用安全入口，例如：

```sh
bun run check:package-pack -- velaros
```

`bun pm pack` 的目标由当前工作目录决定。仓库安全入口负责切换到目标包、建立独占临时目录、限制执行时间并回收进程组；新流程复用 [safe-package-pack.mjs](../../scripts/release/safe-package-pack.mjs)。

发布流程由维护者本机执行，GitHub Actions 中的工作流是禁用的策略哨兵。正式发布要求干净工作树，以及官方远端 tag、本地 tag 和 HEAD 的身份一致；步骤及恢复规则见 [本机发布](local-package-release.md)。根版本用于整列 tag，各包按自己的版本发布，`velaros.platform` 表示兼容代。

Git 推送、包发布和消费者升级是三个独立阶段。交付推送后核对本地 SHA、远端分支 SHA 和追踪分支差异；上传文档本身不会更新已安装的包。

## 持续保存工程记忆

长期规则进入现有架构说明或 ADR；一次实验的结果进入带日期的验证记录。记录需要留下触发条件、通用根因、所有者、复现或验收入口，以及结果的适用范围。过往日志中的通过次数属于当时的源码身份。

在共享工作区先盘点改动，再精确暂存自己负责的文件。基线失败、被中断的检查和真实通过分别记录。交接时同时区分 Git 中的源码、工作区代码、忽略目录中的实验资料和已发布包；[状态快照](handoff-state-20261015.md)提供本次交接的具体边界。
