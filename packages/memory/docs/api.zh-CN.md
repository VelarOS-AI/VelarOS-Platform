# `@velaros-ai/memory` 接口文档

## 定位与非目标

本包提供证据驱动的长期记忆树、召回、Dream 整理、版本投影、完整性校验与遗忘治理。
它不负责知识库向量检索、模型选择、工作区状态、聊天存储或任何桌面 UI。产品上下文到
`MemoryScopeId` 的映射必须由宿主完成。

## 安装

```bash
npm install @velaros-ai/memory
```

完整运行时以 ESM 发布，要求 Node.js 20 或更高版本。宿主需要提供一个已经打开的
`better-sqlite3` 数据库连接。只消费 `/contracts` 的浏览器、renderer 或 Web Worker
不需要 Node.js 运行时和 Node 类型声明。

## 公共入口

- `@velaros-ai/memory`：运行时、领域类型、scope、工具契约。
- `@velaros-ai/memory/contracts`：浏览器安全的纯类型领域 DTO。
- `@velaros-ai/memory/cli`：命令行入口。

不应从 `dist/` 或源码目录深层导入。

```ts
import type {
  MemoryDreamRunResult,
  MemoryRecallItem,
  MemoryTreeDiagnostics,
} from '@velaros-ai/memory/contracts'
```

`/contracts` 的运行时 JavaScript 为空，不会加载 SQLite、存储、Dream 执行器或工具集合。

## 核心类与接口

- `MemoryRuntime`：保留 0.3.x 结构兼容性的最小接口，同时也是默认实现的构造器入口。
- `DefaultMemoryRuntime`：一个宿主独占的对象图，公开 `domain`；`memoryDomainService` 是兼容成员。
- `MemoryTreeDomain`（兼容别名 `MemoryDomain`）：采集、召回、Dream、治理与诊断门面。
- `MemoryTreeRuntimeProviders`：运行时依赖集合。
- `MemoryDatabaseProvider`：返回宿主所持 SQLite 连接。
- `MemoryApi`：供工具或适配器消费的稳定异步/同步兼容接口。
- `MemoryScopeId`：隔离用户、项目、站点或会话记忆的稳定身份。

`createMemoryRuntime(providers)` 是 `new MemoryRuntime(providers)` 的兼容工厂，并返回
`DefaultMemoryRuntime`。旧代码仍可只实现 `MemoryRuntime.memoryDomainService`。

## 生命周期/并发

每个数据库或租户创建一个 `MemoryRuntime`，不要跨不相关租户共享实例。数据库连接由宿主
拥有，因此连接的打开、事务调度和关闭也由宿主负责。写入应由宿主在数据库层串行化；
同一连接上的领域方法不会创建隐藏的全局锁。

## 依赖注入

```ts
const runtime = new MemoryRuntime({
  databaseProvider: () => database,
})
```

运行时不读取环境变量，也不发现 Desktop、Workbench 或 Workspace。数据库是唯一必需端口。

## 错误模型

输入校验、未找到记录和存储失败使用 `@velaros-ai/core/error` 的 `AppError`。调用方可依据
`code` 做稳定分支，并将 `message` 用于日志。不要依赖完整中文错误文案做程序判断。

## 最小第三方示例

```ts
import {
  DefaultMemoryRuntime,
  type MemoryTreeRuntimeProviders,
} from '@velaros-ai/memory'

declare const providers: MemoryTreeRuntimeProviders

const memory = new DefaultMemoryRuntime(providers)

memory.memoryDomainService.captureEvidence({
  scopeId: 'user:demo',
  scopeType: 'global',
  sourceType: 'import',
  trustLevel: 'user_stated',
  content: '用户偏好简洁的技术说明。',
})

const items = memory.domain.recall('技术说明偏好')
console.log(items)
```

仓库中的 [`examples/minimal.ts`](../examples/minimal.ts) 会随包发布，并在发布门禁中以
NodeNext、`skipLibCheck: false` 编译。

## 扩展点

- 在宿主层实现 scope resolver，以适配任意产品身份模型。
- 通过 `MemoryApi` 包装远程调用或权限门，而不修改领域实现。
- 使用树版本、完整性报告和 Evidence eligibility 构建自定义治理界面。

## 兼容策略

0.3.x 保留 `createMemoryRuntime`、`MemoryDomain` 和现有领域方法。新增 class 入口不改变工厂
返回对象的可用属性。历史 Evidence、树版本和治理数据不会因升级自动删除或重建；破坏性
存储迁移必须在新的主版本中明确说明。发布声明使用包内模块化 utility types，不注入
ambient globals，也不会与 Core/UI 的类型声明冲突。
