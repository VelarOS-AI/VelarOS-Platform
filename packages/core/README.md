# @velaros-ai/core

VelarOS 各领域都可复用的无领域语义基础包。

Core 只负责：

- 断言、错误与 `Result`。
- 日志抽象。
- 运行时类型守卫。
- 数组、字符串、数字、JSON、空值、定时器与文件持久化等通用原语。

Core 不负责：

- Kernel ABI、协议、运行时、客户端或进程装配；这些统一属于 `@velaros-ai/kernel`。
- Agent 消息、会话、工具契约、上下文预算或执行语义；这些属于 `@velaros-ai/agent`。
- 模型计价；它属于 `@velaros-ai/model`。
- CLI 连接与路由；它属于 `@velaros-ai/cli`。
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

```ts
import { isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
```

## 归属规则

一个能力只有在同时满足以下条件时才允许进入 Core：

1. 不包含 Agent、Kernel、模型、产品或具体能力域语义。
2. 不依赖任何 VelarOS 领域包。
3. 至少被两个不相邻领域实际复用，且抽取后接口仍然自然。

否则放回拥有该语义的模块。`check:core-semantic-vocabulary` 会阻止领域词重新进入 Core；
包依赖方向由架构门禁检查。
