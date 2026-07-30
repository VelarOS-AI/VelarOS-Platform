# @velaros-ai/agent/protocol

> `@velaros-ai/agent` 的一个导入切片(`packages/agent/src/protocol`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

Agent 能力**跨进程、跨语言、跨版本传输时的严格数据契约**:消息帧、会话树、执行请求、
工具租约、外部 Agent 桥接、可观测性 span、Agent 领域 mod manifest。

它**只描述数据形状**——不执行 agent、不存会话、不选模型,也不含任何产品 / 工作区 / 浏览器语义。
运行时依赖只有 `zod`,所以一个只想解析消息帧的进程(RPC 前脸、日志分析、外部桥接)
可以只装这一片,不吃进整个执行运行时。

## 设计判决:schema 优先,没有 class

本切片刻意采用「**zod schema + `z.infer` 推导类型**」,**没有任何需要实例化的状态类**。
每个公共 wire object 都同时提供 schema 与由它推导的 TS 类型,两者不会漂移。

对象一律**严格**:未知字段直接拒绝。这是有意的——wire 上多出来的字段意味着两端版本不一致,
静默吞掉会变成难查的坏账。

## 主要契约族

| 子路径 | 装什么 |
| --- | --- |
| `./message` | 版本化 Agent 消息帧 |
| `./session` | 会话树与分支关系 |
| `./execution` | 无状态单轮执行协议(请求 / 响应) |
| `./lease` | 工具目录快照与有界工具租约 |
| `./observability` | 执行 span(判别联合:`run` / `turn` / `model` / `tool` / `capability` / `policy`)与 run span、span 指标 |
| `./mods` | Agent 领域 mod manifest 与解析器(两级注册机第二级的数据契约) |
| `./external-agent-bridge` | 对接外部执行引擎时的输入 / 输出 / 错误收口 |

根入口 `@velaros-ai/agent/protocol` 再导出全部契约族,外加 `version`(协议版本常量)。

## 用法

```ts
import { RunTurnRequestSchema, type RunTurnRequest } from '@velaros-ai/agent/protocol/execution'

// 可信边界:解析失败即抛 ZodError
const request: RunTurnRequest = RunTurnRequestSchema.parse(payload)

// 不可信边界:用 safeParse,把失败映射成宿主自己的协议错误
const parsed = RunTurnRequestSchema.safeParse(untrusted)
if (!parsed.success) return toProtocolError(parsed.error)
```

跨进程判兼容性看 `protocolVersion` 与目录修订号,**不要依赖对象身份**;解析后的对象当不可变值用。

## 边界

- **不定义** Kernel 模块生命周期、权限、状态、能力路由、产品装配——那些住内核基座
  `@velaros-ai/core/kernel/abi`(模块 ABI)与 `@velaros-ai/core/kernel/protocol`(wire 调用信封)。
- 无全局注册表,不读环境变量。模型、工具执行器、存储、权限、传输都由上层注入,
  本切片只在它们的传输边界做验证。
- 能力自己的 payload 形状留在对应能力包,不塞进本切片的严格对象。

## ⚠️ 已知欠账:span 契约没有快照锁

`observability.ts` 的 `ExecutionSpanSchema` / `RunSpanSchema` / `ExecutionSpanMetricsSchema`
**只有 zod 定义,没有基线快照**。`check:agent-schemas` 的三道防线都不覆盖它,
而消费方是 Desktop 的执行 span 账本(`storage/chat/execution-spans/*.jsonl`)
——**字段悄悄改掉 = 静默坏账,今天没有门能拦**。

落点:照 kernel 的形状给 `scripts/agent/check-schemas.mjs` 加第四道防线,快照进 `baselines/agent/`。
详见仓根 [README](../../../../README.md)「已知欠账」第 6 条。

## 兼容策略

同一协议主版本内**只做向后兼容的字段 / schema 扩展**。改字段含义、删字段、收紧已接受输入,
都要提升协议主版本并更新 schema 基线。旧别名在移除前按 SemVer 走弃用周期。
