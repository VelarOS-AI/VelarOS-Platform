# `@velaros-ai/memory` 0.5.0 → 0.6.0 迁移表

这是一次**破坏性**发布：6 个入口收成 **2 个**，公开面 204 个名字收到 130 个（**77 个下线、3 个新名字**），
另有**模型面的四处删改**（M4、M5）。类一个都不出包，工具函数一个都不出包。

- 判断口径：消费点 = 直接 `import … from '@velaros-ai/memory*'` 的源文件数（注释与文档不计）。
- 仓内消费点**本轮已全部改完**（包内测试与探针、`tests/memory/maintained`、发版夹具）。
- 产品仓的调用点**本轮不改**，只列进第 6 节。Workbench、Termel、Extension 零引用。

改造方案见 `memory.md`（§2.6 两个入口、§3.5 逐符号迁移表、§4.3 工具面删改）；
裁决见 `foundation-pending-decisions.md` 第三节 M2 / M3 / M4 / M5；仓库标准见
`docs/architecture/module-ownership.md`。

---

## 1. 入口前后对照

| 旧入口（6） | 新入口（2） | 说明 |
| --- | --- | --- |
| `.` | `.` | Node 宿主：工具、工厂、实例、常量表、产品面与注入面的全部接口 |
| `./contracts` | `./contracts` | 可移植数据：`types/memory.ts` + `contract/constants.ts`，运行时 JavaScript 为空 |
| `./backend` | `.` | 后端动词端口与叠加编排的消费方全在宿主主进程 |
| `./files` | `.` | 同上 |
| `./vector` | `.` | 同上；渲染进程唯一用到的 `MemoryVectorBackendId` 进常量表，改从 `./contracts` 取 |
| `./adapter-kernel` | `.` | 三端口胶水与根入口同一个进程，没有独立消费方 |

新入口的值一共 **29 个**：

| 入口 | 值 |
| --- | --- |
| `.` | `memoryTools`；工厂 `createMemoryRuntime`、`mountMemoryAdapter`、`createMemoryTreeStoreBackend`、`createMemoryFilesBackend`、`createNodeMemoryFilesIo`、`createMemoryVectorBackend`、`createFileVectorIndexStore`、`createLayeredMemoryStoreBackend`；实例 `memoryScopes`、`memoryBackends`、`memoryStoreCapabilities`；加 `contract/constants.ts` 的 17 张常量表 |
| `./contracts` | 同一批常量表（`.` 的可移植子集），没有别的值 |

`browserSafeEntries` 仍是 `contracts.ts`：它的引用链不碰 Node 内置模块（INV-12）。

---

## 2. 新增的名字（3）

| 新名 | 它顶替了谁 |
| --- | --- |
| `MemoryTreeRuntimeApi` | `MemoryRuntime`（接口位）与 `DefaultMemoryRuntime`（类位）；文件名与类名现在都叫 `MemoryTreeRuntime` |
| `MemoryTreeServiceOptions` | `MemoryServiceOptions`（类改名 `MemoryTreeService` 之后，选项名跟着类名走） |
| `MemoryHostIdleSignalPort` | `HostIdleSignalPort`（注入面的名字统一带包前缀） |

---

## 3. 有替代的旧名（26）

### 3.1 类 → 工厂与接口

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `new MemoryRuntime(p)` / `new DefaultMemoryRuntime(p)` | `createMemoryRuntime(p)`（本来就有）；类型位用 `MemoryTreeRuntimeApi` | `.` | 3（已改完） | Desktop 1（`src/mods/memory/main/Runtime.ts`） |
| `runtime.domain` | `runtime.memoryDomainService` | `.` | 3（已改完） | Desktop 用的已经是长名 |
| `MemoryDomain`（类型别名） | `MemoryTreeDomainApi` | `.` | 0 | Desktop 4（`agent/context/SessionMemoryTools.ts`、`agent/context/ToolContext.ts`、`bootstrap/RuntimeTypes.ts`、`tests/maintained/.../SessionMemoryTools.test.ts`） |
| `MemoryService`（类与类型） | `MemoryTreeServiceApi`；实例由 `mountMemoryAdapter(...).service` 给 | `.` | 0 | Desktop 2（`bootstrap/RuntimeTypes.ts`、`mods/memory/main/Ipc.ts`） |
| `MemoryEvidenceBridge`（类与类型） | `MemoryEvidenceBridgeApi`；实例是 `adapter.evidenceBridge` | `.` | 1（已改完） | Desktop 2（`chat/ExecutionCoordinator.ts`、`chat/Service.ts`） |
| `MemoryTurnRecallCoordinator`（类与类型） | `MemoryTurnRecallCoordinatorApi`；实例是 `adapter.turnRecall` | `.` | 0 | Desktop 1（`chat/Service.ts`） |
| `MemoryAdapterRuntime`（类与类型） | `MemoryAdapterApi`；`new MemoryAdapterRuntime(i)` → `mountMemoryAdapter(i)` | `.` | 2（已改完） | 0 |
| `MemoryAdapterMount` | `MemoryAdapterApi`（本来就是它的别名） | `.` | 0 | 0 |
| `MemoryDreamScheduler`、`MemoryDream`、`MemoryTreeDomain`、`MemoryTreeRecall`、`MemoryTreeRepository` | 已删无替代：都是 `createMemoryRuntime` / `mountMemoryAdapter` 内部装好的零件 | — | 0 | 0 |
| `InMemoryMemoryFilesIo`、`InMemoryVectorIndexStore`（连同两个工厂与 Api） | 已删无替代：纯内存实现是包内探针与测试用的替身，宿主要内存实现自己写一个 `MemoryFilesIo` | — | 0 | 0 |

### 3.2 工具函数 → 三个实例的方法面

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `buildProjectMemoryScope(root)` | `memoryScopes.projectScope(root)` | `.` | 0 | Desktop 2（`mods/memory/main/DesktopMemoryScope.ts`、`FilesScopeRoots.ts`） |
| `buildSiteMemoryScope(origin)` | `memoryScopes.siteScope(origin)` | `.` | 0 | Desktop 2（同上两个文件） |
| `scopeTypeForScopeId(id)` | `memoryScopes.scopeTypeOf(id)` | `.` | 0 | Desktop 2（`DesktopMemoryScope.ts`、`scripts/checks/kernelAssembly.mjs`） |
| `resolveMemoryScopeSelector(i)` | `memoryScopes.selector(i)` | `.` | 0 | 0 |
| `isMemoryVisibleInScope(t, i)` | `memoryScopes.isVisible(t, i)` | `.` | 0 | 0 |
| `resolveMemoryScopeFilterValue(v)` | 已删无替代：它是召回 SQL 的参数构造，属包内细节 | — | 0 | 0 |
| `supportsMemoryBackendVerb(b, v)` | `memoryBackends.supports(b, v)` | `.` | 0 | Desktop 2（`mods/memory/main/BackendVerbs.ts`、`mods/memory/main/Ipc.ts`） |
| `listMissingAuthorityMemoryVerbs(b)` | `memoryBackends.missingAuthorityVerbs(b)` | `.` | 0 | 0 |
| `isMemoryDerivedIndexBackend(b)` | `memoryBackends.isDerivedIndex(b)` | `.` | 0 | Desktop 1（`bootstrap/composition/memory.ts`） |
| `resolveAuthorityEnumeration(b)` | `memoryBackends.authorityEnumeration(b)` | `.` | 0 | Desktop 1（同上） |
| `formatMemoryDerivedIndexVersion(v)` | 已删无替代：版本戳的展示格式属包内细节 | — | 0 | 0 |
| `memoryStoreCapabilityId(id)` | `memoryStoreCapabilities.capabilityId(id)` | `.` | 1（已改完） | Desktop 1（`mods/memory/main/StoreRegistry.ts`） |
| `createMemoryStoreCapabilityToken(id, v)` | `memoryStoreCapabilities.token(id, v)` | `.` | 1（已改完） | 0 |
| `createMemoryStoreKernelModule(o)` | `memoryStoreCapabilities.createKernelModule(o)` | `.` | 2（已改完） | 0 |
| `resolveMemoryStoreBackend(i)` | `memoryStoreCapabilities.resolveAuthority(i)` | `.` | 2（已改完） | Desktop 2（`bootstrap/composition/memory.ts`、`scripts/checks/kernelAssembly.mjs`） |
| `resolveMemoryDerivedIndexBackends(r, ids, v)` | `memoryStoreCapabilities.resolveDerivedIndexes(r, ids, v)` | `.` | 1（已改完） | Desktop 2（同上） |
| `listRegisteredMemoryStoreBackends(r, ids, v)` | `memoryStoreCapabilities.listRegistered(r, ids, v)` | `.` | 1（已改完） | Desktop 2（同上） |
| `parseMemoryFileDocument` / `serializeMemoryFileDocument` / `parseMemoryIndex` / `serializeMemoryIndex` / `upsertMemoryIndexEntry` / `removeMemoryIndexEntry` / `applyMemoryTreeSchema` | 已删无替代：文件档的落盘格式与建表由后端自己管 | — | 0 | 0 |

### 3.3 散装常量 → 常量表

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| **`MemoryTreeSchemaSql`** | **`MemoryTreeStorage.schemaSql`** | `./contracts` | 0 | **Desktop 1：`src/main/storage/migrations/Migration001Initial.ts` 现在从根入口取建表 SQL，必须改成从 `@velaros-ai/memory/contracts` 取常量表里的这个字段，否则发版就断** |
| `SYSTEM_MEMORY_SCOPE` | `MemoryScopeIds.system` | `./contracts` | 0 | Desktop 4（`chat/ChatSuggestions.ts`、`mods/memory/main/DesktopMemoryScope.ts`、`FilesScopeRoots.ts`、`scripts/checks/kernelAssembly.mjs`） |
| `GLOBAL_MEMORY_SCOPE` | `MemoryScopeIds.global` | `./contracts` | 1（已改完） | 0 |
| `MemoryVectorBackendId` | `MemoryBackendIds.vector` | `./contracts` | 0 | Desktop 3（`bootstrap/Composition.ts`、`plugins/lancedb/main/MemoryVectorBackend.ts`、`plugins/lancedb/renderer/useEmbeddingSettings.ts`——最后一个在渲染进程） |
| `MemoryTreeBackendId` | `MemoryBackendIds.tree` | `./contracts` | 2（已改完） | 0 |
| `MemoryFilesBackendId` | `MemoryBackendIds.files` | `./contracts` | 1（已改完） | 0 |
| `MemoryIndexFileName` / `MemoryIndexHeading` / `MemoryVectorIndexFileName` | `MemoryFilesLayout.indexFileName` / `.indexHeading` / `.vectorIndexFileName` | `./contracts` | 2（已改完） | 0 |
| `MemoryStoreCapabilityNamespace` / `DefaultMemoryStoreCapabilityVersion` | `MemoryStoreCapabilityIdentity.namespace` / `.defaultVersion` | `./contracts` | 1（已改完） | 0 |
| `MemoryVectorIndexSchemaVersion` | `MemoryVectorIndex.schemaVersion` | `./contracts` | 0 | 0 |

### 3.4 只是换了名字的旧别名

| 旧名 | 新名 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `MemoryApi` | `MemoryToolApi` | `.` | 0 | Desktop 1（`main/tools/context/MemoryContextTypes.ts`） |
| `ToolContext` | `MemoryToolContext` | `.` | 0 | 0 |
| `HostIdleSignalPort` | `MemoryHostIdleSignalPort` | `.` | 0 | Desktop 1（`mods/memory/main/HostIdleSignal.ts`） |
| `MemoryServiceOptions` | `MemoryTreeServiceOptions` | `.` | 0 | 0 |
| `ComputerUseObservationInput` / `WorkspaceToolObservationInput` / `ExecutionObservationInput` | `MemoryComputerUseObservationInput` / `MemoryWorkspaceToolObservationInput` / `MemoryExecutionObservationInput`（两套名字本来就并存，现在只留带前缀的一套） | `.` | 0 | 0 |

---

## 4. 已删、没有替代的名字（其余 51 条里的数据类型）

`ForgetMemoryResult`、`GetMemoryResult`、`SaveMemoryResult`、`SearchMemoriesResult`（四个工具回执的
TypeScript 映射：工具回执经模型走，不是宿主签名的一部分）、`MemoryFileDocument`、
`SerializeMemoryFileDocumentInput`、`MemoryIndexEntry`（文件档的落盘格式）、`MemoryTurnRecallDeps`
（协调器的构造参数）、`DefineMemoryToolInput`（定义工具的入参，挪进 `types/tool.ts`）、
`MemoryToolOperationsApi` 与 `memoryToolOperations`（工具执行体，工具文件自己用）、
`MemorySearchModes`（随 `memory:search` 的 `mode` 一起删）。

`MemoryPrivacyClasses` 与类型 `MemoryPrivacyClass` 仍然出包：隐私级还写进条目元数据，
只是不再出现在模型面上（见 §5 的 M5）。

---

## 5. 模型面：M4 与 M5 逐条原文 → 新文

四个工具的名字、`memory:get` 的入参一个字节没动；下面是**改了的部分**。

### 5.1 `memory:save`

| # | 原文 | 新文 |
| --- | --- | --- |
| M4-1 | 参数 `workspaceRoot`：「可选工作区根；默认从当前项目空间派生。」，示例里还带 `"workspaceRoot":"/workspace/VelarOS"` | **整个参数删掉**，示例里也删掉。落点只由作用域两轴决定，模型传什么根都改变不了写到哪；它唯一的作用是把一个错的根写进证据，让树后端长出一个错的项目节点 |
| M5 | 参数 `privacyClass`：「可选隐私级；秘密信息无论级别都禁止写入。」 | **整个参数删掉**。没有任何行为读它（树 v1 不按它过滤，文件档只写进 frontmatter），缺省按类别推；披露闸门接线时再由宿主决定要不要开 |
| M4-2 | `kind` 的 schema 列 14 个值（11 个正式类别 + `session` / `user` / `reference` 三个旧别名），字段说明只有「记忆类别。」 | schema 只列 **11 个正式类别**（旧别名照收，进校验之前折成正式值）；字段说明列出每个值的含义：「记忆类别：fact 稳定事实、preference 偏好、feedback 对协作方式的反馈、procedure 做法、project 项目、task 任务、goal 目标、interest 兴趣、entity 人与事物、artifact 产出物、conversation 对话要点。」 |
| M4-3 | 注意：「同一来源重复提交按来源幂等，不会写出两条。」 | 「同一空间里标题和正文都相同的内容再写一次，不会多出一条；措辞变了就是新的一条。」**实现同改**：工具按「作用域 + 类别 + 标题 + 正文」算一个稳定 `sourceId`，树档与文件档据此得到同一个判据（原文失实——工具从不传 `sourceId`，树档每次都新增一条） |
| — | 参数 `source`：「可选来源说明。」 | 「可选来源说明，只写进记忆文件给人看，不影响召回。」 |
| — | 参数 `tags`：「可选标签，只作为记忆元数据。」 | 「可选标签，只写进记忆文件给人看，不影响召回。」 |

### 5.2 `memory:search`

| # | 原文 | 新文 |
| --- | --- | --- |
| M4-4 | 参数 `mode`（`search` / `browse` / `profile`）与配套的 `superRefine`（「search 模式必须提供 query。」） | **整个参数删掉**。`browse` = 不传 query，`profile` = `categories: ["preference","feedback","interest"]`，两个都是别的参数表达得了的仪式；回执里的 `mode` 字段跟着删 |
| M4-5 | 参数 `workspaceRoot`：无说明 | **整个参数删掉**，理由同 `memory:save` |
| M4-6 | 用法：「search 模式传 query；browse/profile 可以省略 query。」 | 「有明确话题就传 query；想看最近记了什么就不传 query；只看用户画像就传 categories: ["preference","feedback","interest"]。」 |
| M4-7 | 强制流程：「召回按当前空间作用域收敛，外加全局记忆；不跨项目/跨站点翻找。」 | 「只召回当前空间（当前项目、当前站点或系统空间）的记忆，别的空间的看不到。」（原文失实：Desktop 从不写 `global` 作用域，共享池标的是 `system`） |
| M4-8 | 六个字段一个说明都没有 | 四个留下来的字段各补一句：`query`「要找的话题，用用户原话或关键词；不传就是看最近记了什么。」；`limit`「返回多少条，缺省 10 条（不传 query 时 20 条），最多 50 条。」；`deep`「为真时连已归档的一起找，缺省只找在用的。」；`categories`「只看这些类别，不传就是全部类别。」 |
| — | 示例 `{ mode: 'profile', limit: 12 }` | `{ categories: ['preference','feedback','interest'], limit: 12 }` |

### 5.3 `memory:get`

| # | 原文 | 新文 |
| --- | --- | --- |
| M4-9 | 注意：「只能读当前空间可见的记忆（本空间 + 全局）；别的空间的 id 一律当作不存在。」 | 「只能读当前空间的记忆；别的空间的 id 一律当作不存在。」 |

### 5.4 `memory:archive`

| # | 原文 | 新文 |
| --- | --- | --- |
| M4-10 | 参数 `reason`（≤500 字符）与用法里的「reason 只写入本次工具结果，不另建秘密日志」 | **整个参数删掉**（它只回显，是纯仪式）；用法收成「传 memory:search 返回的 id。」；回执里的 `reason` 字段跟着删 |
| M4-11 | 禁止「不要把归档描述成删除——内容一个字节都还在。」＋ 注意「归档不是删除：内容仍在，deep=true 的深层召回仍能翻到。」＋「用户要求「彻底删掉」时如实说明当前只能归档，别承诺物理删除。」（三句讲同一件事） | 合成一句放禁止：「不要说成删除：归档后内容还在，deep=true 仍能找到；用户要彻底删除时如实说明现在只能归档。」 |
| M4-12 | 注意：「只能归档当前空间可见的记忆（本空间 + 全局）……」 | 注意改成两句：「回执的 archived 为 false 表示这个 id 不存在或不在当前空间，要如实告诉用户没有归档成。」「只能归档当前空间的记忆；别的空间的 id 一律当作不存在。」 |

**入参形状变了三处**（宿主若按旧字段拼入参要跟着改）：`memory:save` 少 `workspaceRoot` 与 `privacyClass`，
`memory:search` 少 `mode` 与 `workspaceRoot`，`memory:archive` 少 `reason`。
memory 不在 `check:capabilities-schemas` 的基线里（那道门只覆盖 system / office / composition / browser），
所以没有 schema 基线要重绑；Desktop 的工具卡若读过 `args.mode`，缺席时按它原有的回落显示「记忆召回」。

---

## 6. 产品仓要改的调用点

### 6.1 VelarOS-Desktop（19 个文件）

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `src/main/storage/migrations/Migration001Initial.ts` | `.`: `MemoryTreeSchemaSql` | **`MemoryTreeStorage.schemaSql` from `@velaros-ai/memory/contracts`**（不改就断） |
| `src/mods/memory/main/Runtime.ts` | `.`: `createMemoryRuntime`、`MemoryRuntime` | 工厂名不变；类型位改 `MemoryTreeRuntimeApi` |
| `src/mods/memory/main/DesktopMemoryScope.ts` | `.`: `buildProjectMemoryScope`、`buildSiteMemoryScope`、`scopeTypeForScopeId`、`SYSTEM_MEMORY_SCOPE`、`MemoryScopeId` | `memoryScopes.projectScope` / `.siteScope` / `.scopeTypeOf`；`MemoryScopeIds.system`；`MemoryScopeId` 不变 |
| `src/mods/memory/main/FilesScopeRoots.ts` | `.`: 同上三个；`/files`: `MemoryFilesScopeRoot` | 同上；`MemoryFilesScopeRoot` 从 `.` 取 |
| `src/mods/memory/main/BackendVerbs.ts` | `/backend`: `MemoryBackendVerb`、`MemoryStoreBackend`、`supportsMemoryBackendVerb` | 前两个从 `.` 取（`MemoryBackendVerb` 也在 `./contracts`）；第三个改 `memoryBackends.supports` |
| `src/mods/memory/main/Ipc.ts` | `.`: 两个 DTO；`/adapter-kernel`: `MemoryService`；`/backend`: `MemoryBackendDescriptor`、`MemoryBackendStats`、`supportsMemoryBackendVerb` | `MemoryTreeServiceApi` from `.`；两个 descriptor 类型从 `.` 或 `./contracts` 取；`memoryBackends.supports` |
| `src/mods/memory/main/StoreRegistry.ts` | `/adapter-kernel`: `memoryStoreCapabilityId`、`MemoryStoreCapabilityRegistry`、`MemoryStoreCapabilityService`；`/backend`: `MemoryStoreBackend` | 全从 `.` 取；`memoryStoreCapabilityId` → `memoryStoreCapabilities.capabilityId` |
| `src/mods/memory/main/HostIdleSignal.ts` | `/adapter-kernel`: `HostIdleSignalPort` | `MemoryHostIdleSignalPort` from `.` |
| `src/mods/memory/manifest.ts` | `.`: `memoryTools` | 不变 |
| `src/mods/memory/renderer/hooks/useMemorySettings.ts` | `/contracts`: 两个 DTO | 不变 |
| `src/main/bootstrap/composition/memory.ts` | `/adapter-kernel` 四个、`/backend` 七个、`/files` 两个 | 全从 `.` 取；`resolveMemoryStoreBackend` → `memoryStoreCapabilities.resolveAuthority`，`resolveMemoryDerivedIndexBackends` → `.resolveDerivedIndexes`，`listRegisteredMemoryStoreBackends` → `.listRegistered`，`isMemoryDerivedIndexBackend` → `memoryBackends.isDerivedIndex`，`resolveAuthorityEnumeration` → `memoryBackends.authorityEnumeration` |
| `src/main/bootstrap/Composition.ts` | `/vector`: `MemoryVectorBackendId` | `MemoryBackendIds.vector` from `./contracts` |
| `src/main/bootstrap/RuntimeTypes.ts` | `.`: `MemoryDomain`；`/adapter-kernel`: `MemoryService`；`/backend`: `MemoryStoreBackend` | `MemoryTreeDomainApi`、`MemoryTreeServiceApi`、`MemoryStoreBackend`，全从 `.` 取 |
| `src/main/agent/context/ToolContext.ts` | `.`: `MemoryDomain`、`MemoryScopeId`；`/backend`: `MemoryStoreBackend` | `MemoryTreeDomainApi`；其余从 `.` 取 |
| `src/main/agent/context/SessionMemoryTools.ts` | `.`: `MemoryDomain`；`/backend`: `MemoryStoreBackend` | 同上 |
| `src/main/tools/context/MemoryContextTypes.ts` | `.`: `MemoryApi` | `MemoryToolApi` |
| `src/main/chat/Service.ts` | `/adapter-kernel`: `MemoryEvidenceBridge`、`MemoryTurnRecallCoordinator`、两个 host DTO | `MemoryEvidenceBridgeApi`、`MemoryTurnRecallCoordinatorApi`，全从 `.` 取 |
| `src/main/chat/ExecutionCoordinator.ts` | `/adapter-kernel`: `MemoryEvidenceBridge` | `MemoryEvidenceBridgeApi` from `.` |
| `src/main/chat/ChatSuggestions.ts` | `.`: `MemoryRecallItem`、`SYSTEM_MEMORY_SCOPE` | `MemoryScopeIds.system` |
| `src/plugins/lancedb/main/MemoryVectorBackend.ts` | `/backend`、`/files`、`/vector` 共 7 个 | 全从 `.` 取；`MemoryVectorBackendId` → `MemoryBackendIds.vector` |
| `src/plugins/lancedb/renderer/useEmbeddingSettings.ts` | `/vector`: `MemoryVectorBackendId` | `MemoryBackendIds.vector` from `./contracts`（渲染进程只能加载可移植入口） |
| `scripts/checks/kernelAssembly.mjs` | `/adapter-kernel` 四个、`/backend` 一个、`.` 两个 | 同上的实例方法面 |
| `tests/maintained/src/main/agent/SessionMemoryTools.test.ts`、`tests/maintained/src/main/chat/ChatSuggestions.test.ts` | `.` / `/backend` | 同上 |

另外要改但不是 import 的：`package.json` 与 `bun.lock` 的版本（`^0.6.0`）、
`packages/arch-guard-velaros/src/checks/architecture/memoryProductBoundary.ts` 与
`rendererPortablePackageBoundary.ts` 里按 `@velaros-ai/memory/<子路径>` 字符串与 dist 布局钉的规则
（三切片与 `memory/dist/memory-tree/v2/storage/AtomicFile.js` 那两条已经不成立）。

### 6.2 VelarOS-Workbench / Termel / Extension

零引用，不受影响。

---

## 7. 本轮**没有**做完的

- **树 v2 不出包**（M3 早就落地）：25 个文件除探针外没有消费方，等宿主真要的面定了再开。
- **宿主按作用域给可写根**（M6）属产品层接线：本包只保证作用域对不上根时当场拒收并说清楚。
- `MemoryAdapterApi` 上的 `storeDescriptor` 与 `isDefaultStore` 两个 getter 保留了（方案曾建议收成
  `store.descriptor`）：它们零消费，删不删都不影响宿主，留着不额外制造一次破坏性变更。
