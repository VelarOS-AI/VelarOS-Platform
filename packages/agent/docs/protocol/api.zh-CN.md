# `@velaros-ai/agent/protocol` 中文接口文档

## 定位与非目标

本包定义 Agent 能力跨进程、跨语言或跨版本传输时使用的严格协议：消息、会话树、执行请求、工具租约、外部 Agent 桥接和可观测性帧。它只描述数据形状，不负责执行 Agent、保存会话或选择模型，也不包含任何产品、工作区或浏览器语义。

## 安装

```bash
npm install @velaros-ai/agent/protocol
```

运行时仅依赖 `zod`。包为 ESM，要求 Node.js 20 或更高版本。

## 公共入口

- `@velaros-ai/agent/protocol`
- `@velaros-ai/agent/protocol/execution`
- `@velaros-ai/agent/protocol/external-agent-bridge`
- `@velaros-ai/agent/protocol/lease`
- `@velaros-ai/agent/protocol/message`
- `@velaros-ai/agent/protocol/mods`
- `@velaros-ai/agent/protocol/observability`
- `@velaros-ai/agent/protocol/session`

只从上述 `exports` 入口导入，不要引用 `dist` 内部路径。

## 核心类与接口

本包刻意采用“schema + 推导类型”，没有需要实例化的状态类。每个公共 wire object 都同时提供 Zod schema 和由它推导的 TypeScript 类型。主要契约包括：

- `AgentMessageFrameSchema`：版本化 Agent 消息帧。
- `SessionTreeFrameSchema`：会话树和分支关系。
- `ToolCatalogSnapshotSchema`、`ToolLeaseSchema`：工具目录快照与有界租约。
- `RunTurnRequestSchema`、`RunTurnResponseSchema`：无状态单轮执行协议。
- `AgentExecutionSpanSchema`：执行可观测性数据。
- 外部 Agent 桥接相关 schema：对外部运行时输入、输出和错误进行收口。
- `AgentModManifestSchema`、`parseAgentModManifest`：Agent 领域 Mod Manifest（两级注册机第二级的数据契约，见仓库 `docs/agent-mod-trunk.md`）。

## 生命周期/并发

schema 本身无状态、可并发复用。调用方应把解析后的对象视为不可变值；跨进程通信时应以 `protocolVersion` 和目录修订号判断兼容性，不要依赖对象身份。

## 依赖注入

本包没有全局注册表，也不读取环境变量。模型、工具执行器、存储、权限和传输都由上层注入；本包只在它们的传输边界执行验证。

## 错误模型

`schema.parse(value)` 在无效输入时抛出 `ZodError`；不可信边界建议使用 `safeParse`，把失败映射为宿主自己的协议错误。协议对象使用严格对象 schema，未知字段会被拒绝。

## 最小第三方示例

```ts
import {
  RunTurnRequestSchema,
  type RunTurnRequest,
} from '@velaros-ai/agent/protocol/execution'

const request: RunTurnRequest = RunTurnRequestSchema.parse({
  messages: [{ role: 'user', content: 'Summarize this text.' }],
  tools: [],
  options: { maxToolTurns: 3 },
})

await transport.send(request)
```

## 扩展点

新的 Agent wire object 应在本包新增独立 schema 和稳定导出；具体能力 payload 应留在对应能力协议包中。宿主可通过外部 Agent 桥接契约接入不同执行引擎，但不能把其私有字段塞进现有严格对象。

## 兼容策略

同一协议主版本内只做向后兼容的字段或 schema 扩展。改变字段含义、删除字段或收紧已接受输入，需要提升协议主版本并更新 schema 基线。旧别名在移除前按 SemVer 走弃用周期。
