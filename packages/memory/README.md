# @velaros-ai/memory

> **位置**:VelarOS-Platform 单版本火车 · `memory` 域唯一包 · 目录 `packages/memory`。
> 它同时装三样东西:**长期记忆产品**(根入口)、**工作区知识库**(`/knowledge`)、
> 以及**接进 Kernel 的三端口胶水**(`/adapter-kernel`)。

## 这个包解决什么问题

**记忆**:agent 跨会话记住关于用户、项目、站点的事实与偏好——而且记得**有据可查**。
本包的核心设计是「证据驱动」:任何一条记忆都能回溯到产生它的 Evidence,
不是让模型自由发挥地"总结"出来。配套的还有 MemoryDream(后台整理)、统一意义模型、
版本化树投影、召回、以及**真正删得掉**的遗忘治理。

**知识**(`/knowledge`):把一个工作区的文件与代码增量摄取、分块、做 FTS + 向量混合检索。

**记忆与知识永不合并**——这是域宪章级的判决。它们的生命周期、权威源、隐私含义都不一样,
共用一个包只是因为它们共享嵌入与存储基础设施,不是因为它们是一回事。

## 对外分区

| 子路径 | 一句话职责 |
| --- | --- |
| `@velaros-ai/memory` | 记忆运行时、领域类型、scope、记忆工具 |
| `@velaros-ai/memory/contracts` | **浏览器安全的纯类型** Memory DTO(运行时 JS 为空) |
| `@velaros-ai/memory/backend` | 实现无关的后端动词端口 `MemoryStoreBackend` + 派生索引契约 + 叠加编排 |
| `@velaros-ai/memory/files` | bundled 默认权威档 `memory-files`(宿主注入路径与文件 IO) |
| `@velaros-ai/memory/vector` | **市场可选**派生索引 `memory-vector`(宿主注入嵌入端口与索引存储) |
| `@velaros-ai/memory/cli` | 命令行入口 |
| `@velaros-ai/memory/knowledge` | 工作区资料与代码知识域(摄取 / 检索 / 诊断 / 工具) |
| `@velaros-ai/memory/knowledge/contracts` | 浏览器安全的纯类型 Knowledge DTO |
| `@velaros-ai/memory/knowledge/cli` | knowledge 命令行入口 |
| `@velaros-ai/memory/adapter-kernel` | **唯一合法的** kernel ↔ memory 双向胶水 |

`/contracts` 与 `/knowledge/contracts` 的**运行时 JavaScript 为空**——不会加载 SQLite、
LanceDB、Apache Arrow、Dream 执行器或工具实现。renderer、Web Worker、RPC schema 与前端测试
从这两个入口取类型;Node 宿主继续从包根入口取完整能力。

切片细节见 [`docs/knowledge/README.md`](./docs/knowledge/README.md) 与
[`docs/adapter-kernel/README.md`](./docs/adapter-kernel/README.md)。

## 核心概念

### 后端可插拔,而且是「叠加」不是「竞争」

存储是**后端可插拔**的。`./backend` 是实现无关的动词端口 `MemoryStoreBackend`;
`./files` 是随包发布的默认**权威档**(`memory-files`:markdown + frontmatter + 一个 `MEMORY.md` 索引);
既有的 SQLite 记忆树被逐字包成 `tree` 后端。
Kernel 适配器经 `velaros.memory.store.<backendId>` 这一族 capability token 解析出**一个**后端,
没有后端 mod 注册时回落到 tree ——**不 opt-in 的宿主行为完全不变**。

关键判决:**后端是叠加关系,不是竞争关系**。

```
权威档(authority)      ← 内容永远住这里,唯一真相
   ↑ 叠加
派生索引(derived index) ← 只是加速召回的投影
```

`./vector` 是第一个派生索引(`memory-vector`,市场可选):采集时**双写**,召回时并行跑、
再经指针回权威档取全文,**卸载只掉索引,权威内容一根毫毛都不动**。
嵌入是注入端口(BYOK)——本包不假设任何模型,也不拉任何原生模块。
叠加编排住 `createLayeredMemoryStoreBackend`(`./backend`)。

`memory-vector` **不在 bundled 恒装清单里**:新用户开箱是 files-only,装了才有语义召回。

接线图、宿主挂载点与批次进度见
[`docs/memory/memory-backends.md`](../../docs/memory/memory-backends.md)。

### Scope 是记忆的隔离轴

`MemoryScopeId` 与它的构造器(`buildProjectMemoryScope` / `buildSiteMemoryScope`、
`GLOBAL_MEMORY_SCOPE` / `SYSTEM_MEMORY_SCOPE`)**由本包拥有**。
但**产品上下文到 scope 的映射刻意不归本包**——宿主经 adapter-kernel 的
`MemoryHostScopeResolver` 把自己的上下文映射到一个 scope。本包不认识"聊天会话"是什么。

### v2 权威实现与 legacy 迁移

v2 权威实现同时拥有 legacy Evidence 回放与一致性校验。**legacy 数据库以只读打开**;
权威切换与 legacy 表删除**刻意不作为包操作暴露**。
宿主只有在「精确一致性报告 + 相符的真机回执 + 用户显式签字」三者绑定到同一个校验摘要之后,
才可以考虑切换。

## 典型用法

```ts
import { createMemoryRuntime, memoryTools } from '@velaros-ai/memory'

// 数据库连接由宿主拥有并注入——本包不开、不管、不关
const memory = createMemoryRuntime({ databaseProvider: () => database })

memory.memoryDomainService.captureEvidence({
  scopeId: 'user:demo',
  scopeType: 'global',
  sourceType: 'import',
  trustLevel: 'user_stated',
  content: '用户偏好简洁的技术说明。',
})

const items = memory.domain.recall('技术说明偏好')
```

`examples/minimal.ts` 随包发布,并在发布门禁中以 NodeNext + `skipLibCheck: false` 编译
——它是「第三方真能装上用起来」的机械证据。

## 边界:本包不负责什么

- **不依赖 `@velaros-ai/agent`**、不碰 Desktop IPC、不碰渲染层代码、不认识应用私有的提示词 manifest。
- 根入口**不依赖 `/knowledge`**;工作区知识与嵌入是那边的事。
- **不拥有数据库连接**:打开、事务调度、关闭都归宿主;写入串行化也由宿主在数据库层做,
  领域方法**不创建隐藏的全局锁**。
- 不读环境变量,不去发现 Desktop / Workbench / Workspace。数据库是唯一必需端口。
- 不做产品上下文选择(见上面 scope 那条)。

## 与相邻包的关系

```
@velaros-ai/core   ← 唯一平台上游(AppError 等)
      ↓
@velaros-ai/memory ────────── /adapter-kernel ──────→ @velaros-ai/agent
   (记忆产品本体)              三端口胶水              (kernel 侧持有零个 memory import)
```

kernel 对记忆的**全部**接口就是三个端口——证据采集 / 回合召回 / Dream 调度。
这条接缝是 `@velaros-ai/memory/adapter-kernel` 存在的唯一理由,也是它唯一被允许做的事。

## 生命周期与并发

每个数据库或租户创建**一个** runtime,不要跨不相关租户共享实例。
Knowledge 侧启动时 `warmup()`、退出时 `close()`。

## 错误模型

输入校验、未找到记录、存储失败统一用 `@velaros-ai/core/error` 的 `AppError`。
**按 `code` 分支,不要拿中文 `message` 做程序判断。**

## 兼容策略

0.3.x 保留 `createMemoryRuntime`、`MemoryDomain` 别名与现有领域方法。
**历史 Evidence、树版本与治理数据不会因升级被自动删除或重建**;破坏性存储迁移必须在新主版本里明说。
发布声明使用包内模块化 utility types,不注入 ambient global。
