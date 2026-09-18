# @velaros-ai/velar/memory 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/memory.d.ts`（由 `@AgentView` 从 `MemoryOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/MemoryOperations.ts` 类上方的接口，再看 `contract/requires.ts` 的空间端口；记忆库本身从 `impl/host/MemoryAdapterRuntime.ts` 与 `impl/backends/` 读起。
> 门禁：`bun run check:module-ownership`、`bun run check:code-surface`、`bun run check:memory-boundaries`、`bun run probe:memory`。

## 这是什么

**跨会话的长期记忆**，连同它对模型的那一面。模型面是代码面 `velar:memory` 的四个操作——`save`（写一条）、`search`（按当前空间召回）、
`get`（按 id 读一条）、`archive`（归档一条，让它退出日常召回）；底下是记忆库本身：证据驱动的记忆、接进内核的三端口适配器
（证据采集桥、回合召回协调器、树治理门面），以及三档可插拔的存储后端——树档（SQLite 权威层）、文件档（出厂默认，
`.velaros/memory` 下的 markdown）、向量档（市场可选的语义派生索引）。原来的 `@velaros-ai/memory` 整包并进了这里。

**记忆域的规则只有一处，就在四个操作里**：来源固定 `agent_tool`、信任级封顶 `agent_derived`（模型自报的「用户已确认」铸不出用户事实），
去重键是「作用域 + 类别 + 标题 + 正文」，get 与 archive 过同一条作用域可见性读门，有没有整理管线决定写入回执怎么说。
操作只经空间端口碰记忆后端，不认识后端的形态。

**证据驱动。** 任何一条记忆都能回溯到产生它的证据，不是让模型自由发挥地「总结」出来。后端是**叠加**关系、不是竞争关系：
内容永远住在权威档，派生索引只是加速召回的投影——卸载向量档只掉索引，权威内容一根毫毛都不动。

**召回不折叠。** search 交回的每一条都带着记下的内容（`value`）与来源，模型不必为了看全文再逐条 get；get 用来按 id 读一条
（比如回合召回注入的记忆给了 id），交回的是同一种形状。

它**不拥有工作区资料与代码的知识库**——那是 `velar:knowledge` 的事。「记忆与知识永不合并」是域宪章级的判决：
两边的生命周期、权威源、隐私含义都不一样，两个单元代码上零共享、互不 import。

作用域（`project:<根>`、`site:<源>`、`system`、`global`）的格式由本单元拥有；宿主只负责把它的产品上下文
映射成一个作用域 id，不需要认识这些前缀的含义。

## 提供什么

两个入口，对应包清单 `exports` 里的 `./memory` 与 `./memory/contracts`，源文件是单元目录上的 `index.ts` 与 `contracts.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./memory` | Node 宿主（Desktop 主进程、发版夹具） | 四个操作、运行时与三档后端的工厂、三个规则实例、三端口装配、常量表，以及产品面与注入面的全部接口 |
| `./memory/contracts` | 任何进程，含浏览器、渲染进程与 IPC 契约 | 常量表、**浏览器安全的纯类型**记忆数据（含模型面的入参与回执）、`VelarMemoryModule` |

`./memory/contracts` 不加载 SQLite、Dream 执行器或任何实现。**不要深层导入 `dist/**`，只走这两个入口。**

### 导出的值

| 分组 | 名字 |
| --- | --- |
| 模型面 | `memoryOperations`（代码面 `memory` 命名空间的四个操作）、`VelarMemoryModule`（生成的合同 `contract/surface.ts`：模块名、放出去的方法、完整声明——与 `baselines/code-surface/memory.d.ts` 同一份——与代码模版；空间挂这件能力时交给代码面的门） |
| 运行时与装配 | `createMemoryRuntime`、`mountMemoryAdapter` |
| 规则实例 | `memoryScopes`（作用域规则）、`memoryBackends`（动词与角色判定）、`memoryStoreCapabilities`（后端注册与解析） |
| 后端工厂 | `createMemoryTreeStoreBackend`、`createMemoryFilesBackend`、`createNodeMemoryFilesIo`、`createMemoryVectorBackend`、`createFileVectorIndexStore`、`createLayeredMemoryStoreBackend` |
| 常量表 | `MemoryEvidenceCategories`、`MemoryInputLimits`（这两张写进声明给模型看）、`MemoryEvidenceLimits`、`MemoryPrivacyClasses`、`MemoryBackendIds`、`MemoryBackendVerbs`、`RequiredAuthorityMemoryVerbs`、`MemoryScopeIds`、`MemoryScopePrefixes`、`MemoryStoreCapabilityIdentity`、`MemoryTurnContextSourceId`、`MemoryRecallInspectOperation`、`MemoryFilesLayout`、`MemoryVectorIndex`、`MemoryTreeStorage` |

类一个都不出单元：后端、适配器、治理门面、采集桥、回合召回协调器都是上面的工厂装好的零件，
装配者不需要认识它们；工具函数（作用域计算、动词判定、索引文件解析、向量归一）同理。

### 产品面接口（`contract/provides.ts` 登记，定义在各自的类上方）

`MemoryOperationsApi`、`MemoryTreeRuntimeApi`、`MemoryTreeDomainApi`、`MemoryAdapterApi`、`MemoryTreeServiceApi`、
`MemoryEvidenceBridgeApi`、`MemoryTurnRecallCoordinatorApi`、`MemoryBackendsApi`、`MemoryScopesApi`、
`MemoryStoreCapabilitiesApi`、`MemoryFilesBackendApi`；没有类的 `MemoryTurnContextDeltaSource` 直接声明在 provides 里。

### 注入面接口（`contract/requires.ts`）

- **调用上下文** `MemoryOperationContext`：空间每次分发 `memory` 命名空间的调用时装好——取消信号、这一次调用的会话 id、
  作用域 id 与会话谱系，以及空间端口 `MemorySpacePort`。端口六个方法（`describeBackend`、`captureEvidence`、`recall`、`getMemory`、
  `getDiagnostics`、`archiveMemory`）就是记忆后端的动词，宿主把自己的后端（与自动采集落在同一个后端上）接过来就行。
- **存储与运行时**：`MemoryDatabaseProvider`（宿主已打开的 SQLite）、`MemoryTreeRuntimeProviders`、
  `MemoryStoreBackend` 与 `MemoryDerivedIndexBackend`（两个扩展点）、`MemoryAuthorityEnumeration`、
  `MemoryFilesIo`（文件端口）、`MemoryEmbedder` 与 `MemoryVectorIndexStore`（BYOK 嵌入与向量落盘）。
- **装配与内核**：`MountMemoryAdapterInput`、`MemoryAdapterMountInput`、`MemoryAdapterConfigPort`、
  `MemoryAdapterHostContextPort`、`MemoryAdapterStorePort`、`MemoryAdapterTreePort`、
  `MemoryHostScopeResolver`、`MemoryHostIdleSignalPort`、`MemoryStoreCapabilityRegistry`、
  `MemoryStoreCapabilityService`、`CreateMemoryStoreKernelModuleOptions`、`ResolveMemoryStoreBackendInput`。

上面两面的签名还用到这几个公开形状：`SQLiteDatabase`、`MemoryTreeStoreDomain`、
`LayeredMemoryStoreBackend` 与 `LayeredMemoryStoreBackendOptions`（叠加体）、`MemoryTreeServiceOptions`、
`FileVectorIndexStoreOptions`、`MemoryVectorBackendOptions`。

**宿主怎么挂**：`mountMemoryAdapter(...)` 交出的 `store`（或宿主自己的后端）接成空间端口，每次调用装一份 `MemoryOperationContext`；
空间把四个操作挂到 `memoryOperations` 上，门那边交 `VelarMemoryModule`。空间端口怎么接看 `spec/support.ts`；运行时与适配器怎么装看发版夹具
`scripts/release/fixtures/host-contract-consumer/`（按发布的包严格编译并实跑）。三端口胶水的细节见 `docs/memory/adapter-kernel.md`，
后端接线图见 `docs/memory/memory-backends.md`。

## 骨干链路

模型面的每个操作顺序都固定：先查取消、再核对入参、最后经端口做事——入参错了一步都不做。四个操作都在 `MemoryOperations.ts`。

| 操作或动作 | 链路 |
| --- | --- |
| `save` | 查取消 → `saveInput`：类别只认类别表里的、标题与正文非空且不超上限、其余字段不超上限 → 算去重键，来源固定 `agent_tool`、信任级封顶 `agent_derived`，隐私级按类别推 → `ctx.memory.captureEvidence` → 权威后端落盘（落盘前统一清洗）、装了派生索引时再消费落地结果 → 后端拒收就当场 `VALIDATION`；按后端有没有整理管线回 `availability`（有的才经 `getDiagnostics` 回 `treeVersion`） |
| `search` | 查取消 → `searchInput`：话题去掉首尾空白、条数有话题默认 10 没有默认 20 最多 50、deep 缺省 false、类别只认类别表里的 → `ctx.memory.recall`（按当前空间作用域收敛，global 才代表全部）→ 叠加体先问语义通道拿指针、回权威层取全文，再和词法通道过同一套作用域与归档过滤 → `projectItem` 投影每一条（`utils/mapper.ts`） |
| `get` | 查取消 → `idInput` → `readVisibleMemory`：`ctx.memory.getMemory(id)` 再过 `memoryScopes` 的可见性读门（别的空间的与不存在的一样 `NOT_FOUND`）→ `projectItem` |
| `archive` | 查取消 → `idInput` → 先过与 `get` 同一条读门 → `ctx.memory.archiveMemory(id)` → 按后端实际归没归成如实回 `archived` |
| 宿主接线 | `mountMemoryAdapter({ backend \| store, tree?, config, hostContext })` 一次交出三个接入点——`turnRecall`（回合上下文源）、`evidenceBridge`（会话与执行事件采集）、`service`（后台整理与治理门面） |
| 后端注册 | 后端经 `velaros.memory.store.<id>` 这一族能力令牌注册进内核；`memoryStoreCapabilities.resolveAuthority` 按优先序挑权威层，`resolveDerivedIndexes` 挑派生索引；没有后端 mod 注册时回落到树档 |

## 依赖什么

- 上游包：`@velaros-ai/core`（判定、日志、`AppError`）、`@velaros-ai/kernel`（能力令牌与内核模块）、`@velaros-ai/agent`（peer：回合上下文账本）。
  只在验收里用 `@velaros-ai/code-surface`：跑端到端的程序、给代码模版做类型检查。
- `better-sqlite3`（树档；**连接由宿主打开与关闭**）。
- Node 内置：`node:crypto`、`node:fs`、`node:path`。`./memory/contracts` 的整条引用链不碰它们。
- 不 import `velar:knowledge` 那个单元、不碰 LanceDB 与 Arrow、不依赖任何产品包与 Electron（`check:memory-boundaries` 盯着）；不读环境变量。

## 状态归谁

- **持久状态**属于后端：树档在宿主给的 SQLite 里，文件档在宿主给的作用域根目录下，向量档在它自己的索引文件里。
- **进程内状态**只在实例上：一个宿主一份运行时、一份适配器；后台整理调度器的定时器、回合召回的在途闩、
  文件档的稳定键缓存都是实例字段，模块级没有可变状态。
- 四个操作无状态：每次调用核对、经端口读写、投影，不留任何东西；作用域与会话每次从调用上下文里取，不缓存。

## 生命周期

`createMemoryRuntime(providers)` → `mountMemoryAdapter(...)` → 宿主注册回合上下文源、订阅会话事件 →
`service?.warmup()` 起后台整理 → 退出前 `service?.close()`（只挂独立后端时没有 service）。后端本身无状态启动：
文件档随宿主给的根列表变化，不需要重建；向量档换嵌入模型即整份重建，不写迁移器。
一个数据库或租户一份运行时，不要跨不相关的租户共享实例。

## 失败语义

- 入参不合法：`VALIDATION`，端口一次都不调。
- 后端拒收（当前空间没有可写的记忆目录）：当场 `VALIDATION`，message 让模型如实告诉用户没有写下来，绝不回一句「已记下」。
- 看不见或不存在的 id：`NOT_FOUND`。「越界」与「不存在」回同一个码：分开回等于把「这条存在但不属于你」泄漏出去。
- 归档没归到（记忆目录只读）不是失败：`archived` 为假，声明里写明要如实告诉用户。
- 双写接缝上派生索引写失败只记诊断，不回滚权威写入——派生物可重建，为一个索引回滚用户刚说的话是本末倒置。
- 记忆库的失败一律是 `@velaros-ai/core/error` 的 `AppError`，**按 `code` 分支，不要拿中文 message 判断**；
  代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里。

## 不变量

共 23 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排：INV-1 到 INV-14 是记忆库与四个操作的规则，INV-15 起是模型面。
按检验方式：测试 18 条、门禁 3 条、类型 1 条、文字 1 条。未验证 1 条（INV-14 回合召回的时限与注入上限，要真实会话与计时，留给宿主接线那一轮的真机验收）。

## 非目标

- 不做知识库：工作区文档与代码的索引、检索、诊断在 `velar:knowledge`。
- 不认识产品空间：本单元不知道「项目空间」「浏览器空间」是什么，只认宿主映射好的作用域 id。
- 不让模型自报身份：参数面没有 userConfirmed、trustLevel、sourceType；写下的来源与信任级由操作固定。
- 不物理删除：归档让记忆退出日常召回，内容仍是用户资产；真正的擦除是树 v2 的擦除编排，不在模型面上。
- 不设确认闸（ADR 0009）：写与归档只动记忆库自己的条目，归档也不是删除。
- 不自己开库、不自己发网络请求：SQLite 连接、文件读写、嵌入调用全部经注入端口。
- 不替宿主决定可写根：作用域对不上根就拒收，绝不静默写进别的池子。

## 结构

```text
memory/
  contract/      对外合同三件套：provides.ts 登记类上方接口，requires.ts 是调用上下文、空间端口、存储与装配的端口，
                 constants.ts 是类别、上限、后端与作用域标识、布局常量；surface.ts 是生成的模型面
  types/         只放类型：memory.ts 可移植（含模型面的入参与回执），operations.ts 入参核对的中间形状，
                 backends / files / host / tree / vector 各域，tree-v2/ 树 v2 子系统
  impl/          实现：一个类一个文件，文件名即类名
    MemoryOperations.ts    velar:memory 的四个操作
    host/                  装配、证据采集桥、回合召回、树治理门面、空闲整理调度、后端令牌族
    backends/              叠加体、树后端适配、动词与派生索引判定、作用域规则
    files/ vector/ tree/   三个互不相引的后端实现
    tree-v2/               树 v2：独立子系统，除探针外没人引它，也不出单元
  utils/         纯工具函数：input.ts（入参核对）、mapper.ts（投影成模型面的形状）、operations.ts（隐私级、工作区根、可见性读门），
                 tuning.ts（可调参数表）、作用域、动词、证据清洗、召回、能力令牌、向量，files/ tree/ tree-v2/ 各后端的纯函数
  index.ts       `./memory` 入口，只转发
  contracts.ts   `./memory/contracts` 入口，只转发
  template.js    代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  spec/          不变量登记、验收测试、共用的文件档记忆库、假存储口与模型程序跑法
  test/          实现细节测试（操作、后端、文件档、作用域、适配器、构建产物消费、单独加载）与代码模版逐个函数跑通；
                 probes/ 是树 v2 与三档后端的探针（`bun run probe:memory`）
```

**分层**（登记在 `scripts/ownership/governed-modules.mjs`，上层可以引下层与同层，下层不许引上层）：
`MemoryOperations.ts` → `host/` → `backends/` → `files/` `vector/` `tree/` → `tree-v2/`；utils 在所有层下面。

**改造欠账**：树 v2（独立子系统，除探针外没人引它）不出单元，等宿主真要的面定了再开；
宿主按作用域给可写根属产品层接线，本单元只保证拒收时说清楚。
