# @velaros-ai/core

VelarOS 各领域都可复用的无领域语义基础包：`src/` 里是基础原语，另外三个底层单元按目录放在包里（布局与 `@velaros-ai/velaros` 的能力单元一样，
每个单元有自己的模块卡片 `MODULE.md` 与不变量登记）。

Core 只负责：

- 断言、错误与 `Result`。
- 日志抽象。
- 运行时类型守卫。
- 数组、字符串、数字、JSON、空值、定时器、文件持久化与真实路径（`utils/RealPath`，判定安全用、会追悬空符号链接）等通用原语。

Core 不负责：

- Kernel ABI、协议、运行时、客户端或进程装配；这些统一属于 `@velaros-ai/kernel`。
- Agent 消息、会话、工具契约、上下文预算或执行语义；这些属于 `@velaros-ai/agent`。
- 模型计价；它属于 `@velaros-ai/model`。
- CLI 连接与路由；它属于 VelarOS-Termel 的 `@velaros-ai/cli`。
- Desktop、Workbench、Electron 或任何具体能力实现。

## 公开入口

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/core` | 高频通用原语 |
| `@velaros-ai/core/assert` | 断言 |
| `@velaros-ai/core/error` | `AppError` 与错误处理 |
| `@velaros-ai/core/logger` | logger 与 transport 抽象 |
| `@velaros-ai/core/result` | `Result` |
| `@velaros-ai/core/utils/*` | 低频工具的逐文件入口 |
| `@velaros-ai/core/platform` | 跨平台约定：路径文本、shell 命令规格、进程与系统信息命令、应用与数据目录（`createPlatform`、`currentPlatform`）；不碰 Node 模块，渲染进程也能加载 |
| `@velaros-ai/core/platform/contracts` | 平台约定的可移植数据：环境变量表、shell 种类、命令规格、目录 |
| `@velaros-ai/core/platform/shared-resources` | VelarOS 产品家族共用的数据与资源目录（`velarosSharedResources`），只给 Node |
| `@velaros-ai/core/text-files` | 磁盘文本的无损读写：认编码（BOM、无 BOM 的 UTF-16、UTF-8、GB18030）并严格解码、按原编码写回、原子替换（fsync、权限位精确保留、多硬链接拒写、可核对原字节）、有界读与流式读；只给 Node |
| `@velaros-ai/core/text-files/contracts` | 文本编码词表、错误码与可移植数据 |
| `@velaros-ai/core/path-rules` | 路径命中规则：glob 匹配（目录前缀语义）、.gitignore 的解析与判定、遍历时的忽略策略（有注入的 `git check-ignore` 执行口就先问 git）；只给 Node |
| `@velaros-ai/core/path-rules/contracts` | 默认跳过的目录名与可移植数据 |

```ts
import { isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { currentPlatform } from '@velaros-ai/core/platform'
import { textCodec, textFileIo } from '@velaros-ai/core/text-files'
import { createIgnorePolicy, pathMatcher } from '@velaros-ai/core/path-rules'
```

三个单元各自的说明、骨干链路与不变量见 `platform/MODULE.md`、`text-files/MODULE.md`、`path-rules/MODULE.md`。
它们以前是三个独立的包（`@velaros-ai/platform`、`@velaros-ai/text-files`、`@velaros-ai/path-rules`），并进来后入口换成上表的子路径，名字不变（ADR 0014）。

## 归属规则

一个能力只有在同时满足以下条件时才允许进入 Core：

1. 不包含 Agent、Kernel、模型、产品或具体能力域语义。
2. 不依赖任何 VelarOS 领域包。
3. 至少被两个不相邻领域实际复用，且抽取后接口仍然自然。

否则放回拥有该语义的模块。`check:core-semantic-vocabulary` 会阻止领域词重新进入 Core；
包依赖方向由架构门禁检查。

`unifiedLineDiff` 是通用、有编辑距离上限的 unified diff，供脚本时间线与证据进度共用；调用方可配置上下文行数与编辑距离预算。
