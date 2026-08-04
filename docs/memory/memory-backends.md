# 记忆后端 mod 化 —— Platform 侧实现地图

> **上游权威（只读裁决，住 VelarOS-Desktop 仓）**：`docs/kernel-contract.md` §15.7
> 「记忆后端 mod 化」与 `docs/mod-architecture-blueprint.md` §九「记忆后端 mod」。
> 判决与边界以那两处为准；**本文只记 Platform 仓里判决落到了哪些文件、留了哪些接缝**。
> 冲突时以上游为准，改本文。
>
> 日期：2026-07-30 · 状态：**批一 + 批二已落地**（端口收口 + `memory-files` 默认后端 +
> `memory-vector` 可选派生索引 + 叠加编排）

## 一句话

记忆后端从「适配器直连记忆树领域服务」改成「适配器经 capability token 解析出一个**窄端口后端**」，
并落地了第一个 bundled 默认档 `memory-files`（markdown 权威层）。**既有记忆链路行为零变化**：
不传后端时回落到把记忆树包成的默认后端，每个动词逐字转发。

## 一、现状接线图（批一后）

```
宿主（Desktop / Workbench）
  │  ① 注入 domain（SQLite 记忆树）+ 空闲/配置/scope 三端口
  │  ② 可选：注入 KernelModuleHost 作为后端 registry + 后端优先序
  ▼
mountMemoryAdapter()                       packages/memory/src/adapter-kernel/mount.ts
  │
  ├─ resolveMemoryStoreBackend(registry, preference)   ← capability token 解析
  │     token 族：velaros.memory.store.<backendId>
  │     解析不到 → undefined → 回落 createMemoryTreeStoreBackend(domain)
  │
  ├─ store: MemoryStoreBackend  ────────────┐  窄端口（packages/memory/src/backend/Contract.ts）
  │                                          │  capture / captureBatch / recall / getItem / inspect
  │                                          │  erase? / dream? / govern?（按能力声明，缺席=没装就没有）
  │                                          │
  ├─ evidenceBridge ── captureBatch/dream/govern ─┤   ← 三端口之「会话事件订阅（capture）」
  ├─ turnRecall ───── recall ─────────────────────┤   ← 三端口之「turn-context 源 memory.recall」
  └─ service（MemoryService）── 直连 domain        │   ← 树档自己的治理面（warmup/Dream 调度/树版本）
                                                   │
                        ┌──────────────────────────┴──────────────────────────┐
                        ▼                                                     ▼
        createMemoryTreeStoreBackend(domain)                    createMemoryFilesBackend({roots, io})
        backend/TreeStoreBackend.ts                             files/Backend.ts
        id=tree · role=authority · 六动词全实现                  id=files · role=authority
        每个动词逐字转发 MemoryTreeDomain                        动词=capture/recall/inspect/erase
                        │                                                     │
                        ▼                                                     ▼
              SQLite（Evidence → Dream → Claim/树投影）        markdown + frontmatter + MEMORY.md 索引
```

**三端口（kernel-contract §7）没有变成四个**：工具注册仍走 ToolContext DI，
turn-context 源仍是 `memory.recall` 一个口，会话事件仍只经 `MemoryEvidenceBridge`。
后端可插拔是这三个口**背后**的事，kernel 侧看不见。

### LanceDB 依赖面（澄清一个常见误读）

记忆**主干**（`src/memory-tree/**`）对 LanceDB / apache-arrow 是**零依赖**——召回一直是
SQLite FTS + 树路径。包清单里的 `@lancedb/lancedb` 只服务 `src/knowledge/**` 切片
（工作区知识域，按 kernel-contract §8 不在本次后端判决范围内），`check:memory-boundaries`
机械禁止主干与 adapter-kernel 触达它。

因此 §15.7 裁决三「向量层降位为派生索引」在记忆域是**批二新建**的 `memory-vector`，
不是拆掉某段现存代码。批一留的两处 `TODO(批二)` 接缝**已在批二清除**，落点如下：

| seam | 批一留在哪 | 批二的真身 |
| --- | --- | --- |
| **双写** | `MemoryStoreBackend.captureBatch` 文档 | `backend/Layered.ts` — 权威层先落地，派生层消费落地**结果**（`MemoryEvidenceRecord` 才带指针）；派生写失败只记诊断 |
| **并联** | `MemoryStoreBackend.recall` 文档 | 同上 — 语义命中回权威层 `getItem` 取全文；孤儿当场剔除并异步清理 |
| **角色** | `MemoryBackendRole` | `vector` 以 `derived-index` 入场；`resolveMemoryStoreBackend` 加了**角色门**（权威解析一律跳过派生索引） |

**这道门为什么必须有**：派生索引不持内容。它被当权威层用 = 用户以为记忆写进去了、其实什么都没存。
角色门把「只装了 vector 没装 files」变成「没有权威层 → 缺席」，而不是静默丢数据；`memory-vector`
自己的 `capture` 是第二道门（当场抛错，不返回一个安静的 `inserted: false`）。

## 二、token / 契约的安身处与判据

| 件 | 落点 | 判据 |
| --- | --- | --- |
| 窄动词契约 `MemoryStoreBackend` | `packages/memory/src/backend/Contract.ts`（**主干**） | 它是记忆产品自己的实现无关端口，零 Kernel ABI、零 fs、零 SQL。放主干才能被 files / tree 两个主干实现同时消费 |
| capability token 族 + kernel 模块工厂 | `packages/memory/src/adapter-kernel/MemoryStoreCapability.ts`（**适配器**） | token 是 **mod 轴机制**（`@velaros-ai/kernel/contracts/abi`）。方向铁律 `adapter-kernel → 主干` 单向，主干不得反向依赖适配器，故 token 只能在适配器侧 |
| 为什么不放 Kernel | —— | `packages/kernel/src/**` 有具体能力语义硬墙：出现 `memory` 一词即红 |
| 为什么一档一 token 而非共享 token | `velaros.memory.store.<backendId>` | `KernelServiceStore` 对同一 capability id 只允许一个 active 服务（`DUPLICATE_SERVICE`）。三档要**叠加**（§九 9.2）就必须各占一个 id；共享 id 会把叠加降级成三选一 |
| 为什么是普通服务对象而非 callable capability | `MemoryStoreCapabilityService = { backend }` | 后端解析是记忆产品**进程内**的实现选择，消费者只有适配器自己。对外那张需要审计与权限门的面仍是 `velaros.memory`（`adapter-kernel/kernel-module.ts`），一条没减 |

## 三、`memory-files` API 面

入口：`@velaros-ai/memory/files`

```ts
createMemoryFilesBackend({
  roots,                 // MemoryFilesScopeRoot[] 或 () => MemoryFilesScopeRoot[]
  io,                    // MemoryFilesIo（宿主注入 createNodeMemoryFilesIo()）
  indexFileName,         // 默认 'MEMORY.md'
  entriesDirectoryName,  // 默认 'entries'
  now,                   // 默认 Date.now
}): MemoryStoreBackend

interface MemoryFilesScopeRoot {
  scopeType: MemoryScopeType   // 'global' | 'workspace' | 'site' | 'system' | …
  scopeId: MemoryScopeId       // 'global' | 'project:/abs/path' | 'site:https://…'
  directory: string            // 宿主注入的绝对路径
  readOnly?: boolean           // 别人 clone 来的共享记忆
}
```

### 磁盘布局

```
<root.directory>/
  MEMORY.md              # 索引，一行一条：- [名字](entries/slug.md) — 描述
  entries/<slug>.md      # 权威内容
```

```md
---
name: 回复风格
description: 先结论后细节的简洁中文
type: preference
id: … · scope: … · stableKey: … · source: … · status: active · created/updated: …
---

用户偏好简洁中文回答，先给结论再展开细节。
```

### 行为要点

- **检索** = 索引行匹配（名字 3 分 / 路径 2 分 / 描述 1 分，CJK 走 2-gram）→ 命中头部候选**才**读全文；
  类别过滤在读到的文档上完成。空查询 = browse（最近写入优先）。
- **宽容解析**（权威层要能被用户和外部编辑器直接改）：BOM / CRLF / 缺失 frontmatter /
  别名 key（`title`|`summary`|`kind`|`category`…）/ 引号 / 松散 fence 全认；未知字段原样保留写回；
  未闭合 fence 整篇当正文；**解析永不抛**。
- **幂等**：稳定键 = `sourceId` 或 `hash(sourceType|title|content)`；同键同内容重复写入不新增文件也不算 inserted。
- **归档不是删除**：`erase` 撤索引行 + 打 `status: archived`，文件保留；`includeDormant` 深层召回仍可捞回。
- **缺席动词**：`dream` / `govern` 在 descriptor 与实现上双双缺席 = partial activation 的
  「没装就没有」，不是降级分支。
- **零宿主假设**：目录路径与文件 IO 全部注入；包内不认识 userData，也不认识仓根。

## 三·二、`memory-vector` API 面（批二）

入口：`@velaros-ai/memory/vector`（**不在 bundled 恒装清单里**——新用户开箱 files-only，§九 9.6）

```ts
createMemoryVectorBackend({
  embedder,            // MemoryEmbedder，宿主注入(BYOK):{ identity, dimensions, embed(texts) }
  store,               // MemoryVectorIndexStore;缺省纯内存,持久化用 createFileVectorIndexStore
  embedBatchSize,      // 默认 64
  minimumSimilarity,   // 默认 0.2(地板以下不如空手)
}): MemoryDerivedIndexBackend
```

### 存储选型裁决（依赖剖面）

**落在注入的文本 IO 上（一份 base64 Float32 索引文件）+ 内存暴力余弦**，不是 LanceDB、不是 sqlite-vec：

| 候选 | 判据 | 结论 |
| --- | --- | --- |
| LanceDB | `check:memory-boundaries` **机械禁止** Memory 主干 import `@lancedb/lancedb` / `apache-arrow`（那是 knowledge 切片的）。为向量索引松这道门 = 把 §九「把向量库请出记忆默认档」反着做一遍 | 否 |
| sqlite-vec | 一条**新的平台原生依赖**。派生索引必须装得起也卸得掉，成本落在所有用户身上而收益只落在装了它的人身上 | 否 |
| 文件 + 暴力余弦 | 个人记忆是 10²–10³ 条（权威层是一堆 markdown），不是代码库索引。1000 条 × 1536 维余弦是几毫秒；ANN 在这个量级买的是复杂度不是速度 | **取** |

**这不构成锁死**：检索与存储隔在 `MemoryVectorIndexStore` 端口后，换 ANN 库只换那一格实现，
后端与契约一行不动。落盘文件是纯派生物——格式随时可换（版本戳对不上就整份重建），因此它
不需要宽容解析、不需要迁移器；权威层那三条硬要求（人可读 / 可手改 / 可 diff）在这里一条都不适用。

### 派生索引语义的机械化（`backend/DerivedIndex.ts`）

§九 9.2 / 9.4 的产品判决在这里变成可调用、可探针的动词，而不是实现者的自觉：

| 判决 | 机械落点 |
| --- | --- |
| 索引只持指针与向量，不持内容副本 | `MemoryVectorIndexRecord` 只有 `{ id, scopeType, scopeId, updatedAt, vector }`；探针断言序列化后的索引里搜不到任何正文 |
| 重建代替迁移（schema / 嵌入模型变更） | `MemoryDerivedIndexVersion = { schema, embedding }` + `isStale()`；两段分开是因为它们由不同的人改动（包作者 vs 用户换模型） |
| 卸载只删派生数据 | `dropIndex()` **签名上就够不着权威层**；探针比对卸载前后权威 markdown 逐字节未变 |
| 不吃原始证据 | `descriptor.verbs` **不声明 `capture`** → `supportsMemoryBackendVerb(vector,'capture') === false` 机械可查；`indexEvidence(records)` 才是双写的第二写 |
| 全量重建的枚举 | `MemoryAuthorityEnumeration` 独立端口（**不进窄端口六动词面**）；`memory-files` 结构上自带 `listAll()`，装上索引即可重建，宿主不必再注入 |

**为什么不用 `recall('')` 当枚举**：普通召回有 `limit` 与「按需全文」上限（一次最多读 24 份），
那是**性能承诺**不是缺陷。拿它当枚举会重建出一份看起来在工作的残缺索引——残缺索引比没有索引更坏。

### 叠加编排（`backend/Layered.ts`）

```ts
const store = createLayeredMemoryStoreBackend({
  authority: filesBackend,          // 权威层恒在
  derived: [vectorBackend],         // 派生层可摘,可零个
  onDerivedFailure: (f) => log(f),  // 派生失败只进诊断
})
```

- **capture 双写**：`authority.captureBatch()` 先落地 → 把返回的 `MemoryEvidenceRecord[]` 交派生层。
  吃落地结果而不是原始 input，是因为**只有权威层能分配指针**；也因此不需要按下标去配对 input 与结果。
- **recall 并联**：词法一路（权威层）+ 语义一路（派生层指针 → `authority.getItem` 回捞全文），
  **交错合并**而不是按分数排序——索引行匹配分与余弦相似度不在一个量纲上，把它们放进一个 `sort`
  是在编造一个没人定义过的可比性。交错保住了「装了 vector 只会变好，不会把词法命中挤没」。
- **孤儿**：权威层认不出的指针不进结果，并被异步清出索引。这一条同时覆盖「权威层删了这条」与
  「派生层指针来自别的 id 空间」——后者不值得写第二套逻辑，让它退化成「派生层零贡献」正是缺席时的既定行为。
- **身份**：叠加**不产生第三个后端**，`descriptor.id` 就是权威层的 id；派生层只在 `inspect().details`
  里以 `derived:<id>` / `derived:<id>:stale` 露面。

### mod 化包装样例

后端经既有 token 族注册，**零轴变更**（§九 9.3）——`velaros.mod.json` 里没有任何记忆专属字段：

```json
{
  "module": {
    "id": "velaros.memory-vector",
    "version": "1.0.0",
    "apiVersion": 1,
    "provides": [{ "id": "velaros.memory.store.vector", "version": "1.0.0" }],
    "requires": [],
    "permissions": ["memory:read", "memory:write"],
    "isolation": "in-process",
    "entry": "./index.js"
  },
  "agent": {
    "id": "velaros.memory-vector",
    "version": "1.0.0",
    "manifestSchemaVersion": 1,
    "engines": { "velaros": "^1.0.0", "agent": "^1.0.0" },
    "trust": "bundled-official",
    "contributes": {}
  }
}
```

entry 里做的就是 `createMemoryStoreKernelModule({ backend: createMemoryVectorBackend({ embedder, store }) })`
——**与 `memory-files` 用的是同一个工厂**。「默认已注册后端」和「市场装的后端」在注册路径上没有第二套机制，
这正是 §九「零轴变更」要检验的东西。

## 四、宿主接入点清单（批三要用）

批一**没有改动任何宿主**（Desktop 仍走默认树后端，行为零变化）。批三迁移权威层时要动的位置：

| # | 接入点 | Desktop 现址 | 批三要做什么 |
| --- | --- | --- | --- |
| ① | 适配器 mount 处 | `apps/desktop/src/main/bootstrap/composition/memory.ts` → `assembleMemoryAdapter()` | 给 `mountMemoryAdapter` 补 `store: { registry, preference }` |
| ② | 后端注册处 | 同上（或 Composition 的 kernel host 装配处） | `host.registerModule(createMemoryStoreKernelModule({ backend }))`，files 档恒装、tree 档按迁移状态注册 |
| ③ | 全局路径注入 | `apps/desktop/src/main/memory/Runtime.ts`（现只注入 SQLite provider） | 追加 `{ scopeType:'global', scopeId:'global', directory: <userData>/memory }` |
| ④ | 项目路径注入 | `WorkspaceRootService`（活动项目根，已在 `resolveDesktopMemoryHostScope` 消费） | 按活动根派生 `{ scopeType:'workspace', scopeId:'project:<root>', directory:<root>/.velaros/memory }`；随会话切换 → 用函数式 `roots` |
| ⑤ | 默认 files-only 开关位 | `configService.systemConfig.memory.*`（`memory.enabled` / `backgroundGrowth` / `capture.*` 已在此） | 新增后端优先序配置项；新用户开箱 `['files']`，装了 vector 后 `['files','vector']`（§九 9.6） |
| ⑥ | 诊断面 | 记忆设置页 / `memory/Ipc.ts` | 展示 `adapter.storeDescriptor` 与 `listRegisteredMemoryStoreBackends(...)`（「装了哪些记忆后端」） |
| ⑦ | 树档治理面 | `MemoryService`（warmup / Dream 调度 / 树版本 / 完整性校验） | files-only 宿主不该被迫开 SQLite 记忆树 → `mount` 的 `domain` 需改可选（已在代码里留 `TODO(批三)`） |
| ⑧ | **派生索引装配**（批二产出） | 同 ① / ② | 装了 vector mod 时：`resolveMemoryDerivedIndexBackends(host, ['vector'])` → `createLayeredMemoryStoreBackend({ authority, derived })`，把结果当 `store` 用。没装 = `derived: []` = 与纯权威层逐字等价 |
| ⑨ | **嵌入端口实现**（批二产出） | 宿主模型层（BYOK 的嵌入模型选择已在 Desktop 侧） | 实现 `MemoryEmbedder`：`identity` 必须包含 provider + 模型 + 维度（它进版本戳，换模型即重建）；索引存储用 `createFileVectorIndexStore({ io: createNodeMemoryFilesIo(), directory })`，目录独立于权威层目录，卸载即整目录可删 |

Workbench 侧同理，唯一差别是项目根天然可得，全局面按其 userData 约定注入。

## 五、门与探针

| 门 | 位置 | 拦什么 |
| --- | --- | --- |
| `check:memory-boundaries` | `scripts/memory/checkProductBoundaries.mjs` | 三切片方向矩阵：主干不得触达 knowledge / adapter-kernel；适配器不得触达 knowledge；全切片宿主无关 |
| `check:core-semantic-vocabulary` | `scripts/core/check-semantic-vocabulary.mjs` | 内核本体出现 `memory` 一词即红（token 因此不能住 core） |
| `probe:files`（70 断言） | `packages/memory/src/files/memory-files-probe.ts` | 写入→索引→召回往返（含按需全文/幂等）、宽容 frontmatter、双作用域（含只读根与动态根）、归档语义、后端自述 |
| `probe:vector`（56 断言） | `packages/memory/src/vector/memory-vector-probe.ts` | 后端自述与「不吃原始证据」、双写（含索引无内容副本 / 向量已归一）、派生层炸了不影响权威层、并联回捞全文、孤儿清理、rebuild 幂等 + 版本戳、换嵌入模型即过期、**卸载零损失**（权威 markdown 逐字节未变）、索引落盘往返 |
| `probe:store-capability`（37 断言） | `packages/memory/src/adapter-kernel/memory-store-capability-probe.ts` | token 族形状、两档并存注册、优先序切换、缺席与版本不匹配、默认回落的逐字转发、解析到 files 时两端口确实改道、**派生索引角色门**（vector 当不成权威后端 + 派生解析口） |

三条探针均为**构造级**（bun 直驱，IO 与嵌入端口注入，不落真实文件、不开 SQLite、不发一次网络请求），
已挂进根 `probe:memory` → `check:gates` → `bun run check`。

## 六、批次进度（对齐 §九 9.7）

- **P0'** 判决并入文档 —— 已完成（上游两文 + 本文）。
- **批一** `memory-files` 落地 + 端口收窄 —— **本批完成**。
- **批二** `memory-vector` 作为市场 mod —— **本批完成**：`./vector` 切片（后端 + 两种索引存储）、
  `backend/DerivedIndex.ts`（派生索引语义机械化）、`backend/Layered.ts`（双写 + 并联）、
  权威解析的角色门、`probe:vector`。窄端口形状**一行未改**——判决说的「不需要再改端口形状」成立。
  欠账：Desktop 侧接线（见第四节 ⑧⑨）与真实嵌入端口实现（宿主侧，BYOK）。
- **批三** 迁移既有记忆数据 → files 权威层，旧地基物理删除 —— 接入点见第四节。
