# @velaros-ai/memory 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 门禁：`bun run check:module-ownership`（本模块零条）。
>
> 0.6.0 是一次**破坏性**发布：入口从六个收成两个，类与工具函数不再出包。
> 逐符号去向见 `docs/engineering/refactor-plans/memory-migration.md`。

## 这是什么

**跨会话的长期记忆**：四个模型面工具（`memory:save / search / get / archive`）、宿主接线用的三端口适配器
（证据采集桥、回合召回协调器、树治理门面），以及三档可插拔的存储后端——树档（SQLite 权威层）、
文件档（出厂默认，`.velaros/memory` 下的 markdown）、向量档（市场可选的语义派生索引）。

它**不拥有工作区资料与代码的知识库**——那是 `@velaros-ai/knowledge` 的事。
「记忆与知识永不合并」是域宪章级的判决：两边的生命周期、权威源、隐私含义都不一样，
现在连包也是两个，代码上零共享、互不 import。

作用域（`project:<根>`、`site:<源>`、`system`、`global`）的格式由本包拥有；宿主只负责把它的产品上下文
映射成一个作用域 id，不需要认识这些前缀的含义。

## 提供什么

两个入口，对应 `package.json` 的 `exports`：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主（Desktop 主进程、发版夹具） | 四个工具、运行时与三档后端的工厂、三个规则实例、常量表，以及产品面与注入面的全部接口 |
| `./contracts` | 任何进程，含渲染进程与 IPC 契约 | **浏览器安全的纯类型**记忆 DTO 加常量表（不碰 Node 内置模块） |

### 导出的值

| 分组 | 名字 |
| --- | --- |
| 工具集合 | `memoryTools` |
| 运行时与装配 | `createMemoryRuntime`、`mountMemoryAdapter` |
| 规则实例 | `memoryScopes`（作用域规则）、`memoryBackends`（动词与角色判定）、`memoryStoreCapabilities`（后端注册与解析） |
| 后端工厂 | `createMemoryTreeStoreBackend`、`createMemoryFilesBackend`、`createNodeMemoryFilesIo`、`createMemoryVectorBackend`、`createFileVectorIndexStore`、`createLayeredMemoryStoreBackend` |
| 常量表 | `MemoryToolNames`、`MemoryToolCategoryId`、`MemoryToolLimits`、`MemoryEvidenceLimits`、`MemoryEvidenceCategories`、`MemoryEvidenceCategoryAliases`、`MemoryPrivacyClasses`、`MemoryBackendIds`、`MemoryBackendVerbs`、`RequiredAuthorityMemoryVerbs`、`MemoryScopeIds`、`MemoryScopePrefixes`、`MemoryStoreCapabilityIdentity`、`MemoryTurnContextSourceId`、`MemoryFilesLayout`、`MemoryVectorIndex`、`MemoryTreeStorage` |

类一个都不出包：后端、适配器、治理门面、采集桥、回合召回协调器都是上面的工厂装好的零件，
装配者不需要认识它们；工具函数（作用域计算、动词判定、索引文件解析、向量归一）同理。

### 产品面接口（`contract/provides.ts` 登记，定义在各自的类上方）

`MemoryTreeRuntimeApi`、`MemoryTreeDomainApi`、`MemoryAdapterApi`、`MemoryTreeServiceApi`、
`MemoryEvidenceBridgeApi`、`MemoryTurnRecallCoordinatorApi`、`MemoryBackendsApi`、`MemoryScopesApi`、
`MemoryStoreCapabilitiesApi`、`MemoryFilesBackendApi`、`MemoryToolCollection`、`MemoryTurnContextDeltaSource`。

### 注入面接口（`contract/requires.ts`）

存储与运行时：`MemoryDatabaseProvider`（宿主已打开的 SQLite）、`MemoryTreeRuntimeProviders`、
`MemoryStoreBackend` 与 `MemoryDerivedIndexBackend`（两个扩展点）、`MemoryAuthorityEnumeration`、
`MemoryFilesIo`（文件端口）、`MemoryEmbedder` 与 `MemoryVectorIndexStore`（BYOK 嵌入与向量落盘）。

装配与内核：`MountMemoryAdapterInput`、`MemoryAdapterMountInput`、`MemoryAdapterConfigPort`、
`MemoryAdapterHostContextPort`、`MemoryAdapterStorePort`、`MemoryAdapterTreePort`、
`MemoryHostScopeResolver`、`MemoryHostIdleSignalPort`、`MemoryStoreCapabilityRegistry`、
`MemoryStoreCapabilityService`、`CreateMemoryStoreKernelModuleOptions`、`ResolveMemoryStoreBackendInput`。

工具经上下文 `MemoryToolContext` 里的 `ctx.memory`（宿主端口 `MemoryToolApi`，六个方法）调宿主；
一个工具的运行期形状是 `VelaTool`。

上面两面的签名还用到这几个公开形状：`SQLiteDatabase`、`MemoryTreeStoreDomain`、
`LayeredMemoryStoreBackend` 与 `LayeredMemoryStoreBackendOptions`（叠加体）、`MemoryTreeServiceOptions`、
`FileVectorIndexStoreOptions`、`MemoryVectorBackendOptions`。

## 骨干链路

四个工具的定义、分组与挂载都在工具文件 `impl/MemoryTools.ts`，execute 各一行交给 `MemoryToolOperations`。

- **写**：`memory:save` → `MemoryToolOperations.save` 算稳定去重键（作用域 + 类别 + 标题 + 正文）→
  `ctx.memory.captureEvidence` → 权威后端落盘（落盘前统一清洗）→ 装了派生索引时再消费落地结果。
- **召回**：`memory:search` → `ctx.memory.recall` → 叠加体先问语义通道拿指针、回权威层取全文，
  再和词法通道过同一套作用域与归档过滤 → 投影成紧凑条目交给模型。
- **读一条**：`memory:get` → `ctx.memory.getMemory(id)` → 过 `memoryScopes` 的可见性读门 → 回全文与来源。
- **归档**：`memory:archive` → 先过与 `memory:get` 同一条读门 → `ctx.memory.archiveMemory(id)` →
  按后端实际归没归成如实回执。
- **宿主接线**：`mountMemoryAdapter({ backend | store, tree?, config, hostContext })` 一次交出三个接入点——
  `turnRecall`（回合上下文源）、`evidenceBridge`（会话与执行事件采集）、`service`（后台整理与治理门面）。
- **后端注册**：后端经 `velaros.memory.store.<id>` 这一族能力令牌注册进内核；
  `memoryStoreCapabilities.resolveAuthority` 按优先序挑权威层，`resolveDerivedIndexes` 挑派生索引。

## 依赖什么

`@velaros-ai/core`（判定、日志、`AppError`）、`@velaros-ai/kernel`（能力令牌与内核模块）、
`@velaros-ai/tool-contract`（工具定义与渲染）、`better-sqlite3`（树档）、`zod`（入参 schema）。
不依赖 `@velaros-ai/knowledge`、不依赖任何产品包、不依赖 Electron（`check:memory-boundaries` 盯着）。

## 状态归谁

- **持久状态**属于后端：树档在宿主给的 SQLite 里，文件档在宿主给的作用域根目录下，向量档在它自己的索引文件里。
- **进程内状态**只在实例上：一个宿主一份运行时、一份适配器；后台整理调度器的定时器、回合召回的在途闩、
  文件档的稳定键缓存都是实例字段，模块级没有可变状态。
- 本包不读进程全局配置，也不读环境变量（登记表里没有环境变量表）。

## 生命周期

`createMemoryRuntime(providers)` → `mountMemoryAdapter(...)` → 宿主注册回合上下文源、订阅会话事件 →
`service.warmup()` 起后台整理 → 关闭时 `service.dispose()`。后端本身无状态启动：
文件档随宿主给的根列表变化，不需要重建；向量档换嵌入模型即整份重建，不写迁移器。

## 失败语义

- 模型看得到的失败一律是 `AppError`：作用域没有可写根 → `VALIDATION`；看不见或不存在的 id → `NOT_FOUND`。
- 「越界」与「不存在」回同一个码：分开回等于把「这条存在但不属于你」泄漏出去。
- 后端拒收时工具**当场报错**，绝不回一句「已记下」让模型去向用户承诺一件没发生的事；
  归档没归成时回执 `archived: false` 并让模型如实说明。
- 双写接缝上派生索引写失败只记诊断，不回滚权威写入——派生物可重建，为一个索引回滚用户刚说的话是本末倒置。

## 不变量

共 14 条，登记在 `spec/invariants.md`（测试 10、类型 1、门禁 2、未验证 1 条）。
验收测试 `spec/acceptance.test.ts` 只经根入口，每条测试档不变量各有一个以编号开头的用例。

## 非目标

- **不做知识库**：工作区文档与代码的索引、检索、诊断在 `@velaros-ai/knowledge`。
- **不认识产品空间**：本包不知道「项目空间」「浏览器空间」是什么，只认宿主映射好的作用域 id。
- **不物理删除**：归档让记忆退出日常召回，内容仍是用户资产；真正的擦除是树 v2 的擦除编排，不在工具面上。
- **不自己开库、不自己发网络请求**：SQLite 连接、文件读写、嵌入调用全部经注入端口。
- **不替宿主决定可写根**：作用域对不上根就拒收，绝不静默写进别的池子。

## 结构

```text
packages/memory/
  MODULE.md             这一页
  spec/                 不变量登记与验收测试（只经根入口）
  test/                 实现细节测试
  probes/               树 v2 与三档后端的探针（`bun run probe:memory`）
  examples/minimal.ts   随包发布，发布门禁用 NodeNext 编译
  src/
    contract/  provides.ts   requires.ts   constants.ts
    types/     memory.ts（可移植）+ backends / files / host / tool
    impl/      MemoryTools.ts、MemoryToolOperations.ts + backends / files / host / tree / tree-v2 / vector
    utils/     tuning.ts + 作用域、动词、证据清洗、索引文件、向量、能力令牌等
    index.ts       根入口（`.`）
    contracts.ts   可移植数据入口（`./contracts`）
```

**分层**（登记在 `scripts/ownership/governed-modules.mjs`，上层可以引下层与同层，下层不许引上层）：
`MemoryTools.ts` → `MemoryToolOperations.ts` → `host/` → `backends/` → `files/` `vector/` `tree/` → `tree-v2/`；
utils 在所有层下面。

**改造欠账**：树 v2（独立子系统，除探针外没人引它）不出包，等宿主真要的面定了再开；
宿主按作用域给可写根属产品层接线，本包只保证拒收时说清楚。
