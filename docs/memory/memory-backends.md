# 记忆后端 mod 化 —— Platform 侧实现地图

> **上游权威（只读裁决，住 VelarOS-Desktop 仓）**：`docs/kernel-contract.md` §15.7
> 「记忆后端 mod 化」与 `docs/mod-architecture-blueprint.md` §九「记忆后端 mod」。
> 判决与边界以那两处为准；**本文只记 Platform 仓里判决落到了哪些文件、留了哪些接缝**。
> 冲突时以上游为准，改本文。
>
> 日期：2026-07-29 · 状态：**批一已落地**（端口收口 + `memory-files` 默认后端）

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

因此 §15.7 裁决三「向量层降位为派生索引」在记忆域是**批二要新建**的 `memory-vector`，
不是要拆掉某段现存代码。批一只在两处留了接缝注释与 `TODO(批二)`：

| seam | 位置 | 批二要做什么 |
| --- | --- | --- |
| **双写** | `MemoryStoreBackend.captureBatch` 文档 | 权威后端先落地，派生索引再消费同一批 input；派生写失败不回滚权威写入 |
| **并联** | `MemoryStoreBackend.recall` 文档 | 语义命中回权威后端取全文；索引只持指针与向量，不持内容副本 |
| **角色** | `MemoryBackendRole = 'authority' \| 'derived-index'` | vector 以 `derived-index` 入场；卸载只删索引 |

## 二、token / 契约的安身处与判据

| 件 | 落点 | 判据 |
| --- | --- | --- |
| 窄动词契约 `MemoryStoreBackend` | `packages/memory/src/backend/Contract.ts`（**主干**） | 它是记忆产品自己的实现无关端口，零 Kernel ABI、零 fs、零 SQL。放主干才能被 files / tree 两个主干实现同时消费 |
| capability token 族 + kernel 模块工厂 | `packages/memory/src/adapter-kernel/MemoryStoreCapability.ts`（**适配器**） | token 是 **mod 轴机制**（`@velaros-ai/core/kernel/abi`）。方向铁律 `adapter-kernel → 主干` 单向，主干不得反向依赖适配器，故 token 只能在适配器侧 |
| 为什么不放 core | —— | `packages/core/src/kernel/**` 有语义词汇硬墙（`check:core-semantic-vocabulary`，**无 baseline 逃生**）：出现 `memory` 一词即红 |
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

Workbench 侧同理，唯一差别是项目根天然可得，全局面按其 userData 约定注入。

## 五、门与探针

| 门 | 位置 | 拦什么 |
| --- | --- | --- |
| `check:memory-boundaries` | `scripts/memory/checkProductBoundaries.mjs` | 三切片方向矩阵：主干不得触达 knowledge / adapter-kernel；适配器不得触达 knowledge；全切片宿主无关 |
| `check:core-semantic-vocabulary` | `scripts/core/check-semantic-vocabulary.mjs` | 内核本体出现 `memory` 一词即红（token 因此不能住 core） |
| `probe:files`（70 断言） | `packages/memory/src/files/memory-files-probe.ts` | 写入→索引→召回往返（含按需全文/幂等）、宽容 frontmatter、双作用域（含只读根与动态根）、归档语义、后端自述 |
| `probe:store-capability`（32 断言） | `packages/memory/src/adapter-kernel/memory-store-capability-probe.ts` | token 族形状、两档并存注册、优先序切换、缺席与版本不匹配、默认回落的逐字转发、解析到 files 时两端口确实改道 |

两条探针均为**构造级**（bun 直驱，IO 注入，不落真实文件、不开 SQLite），已挂进
根 `probe:memory` → `check:gates` → `bun run check`。

## 六、批次进度（对齐 §九 9.7）

- **P0'** 判决并入文档 —— 已完成（上游两文 + 本文）。
- **批一** `memory-files` 落地 + 端口收窄 —— **本批完成**。
- **批二** `memory-vector` 作为市场 mod —— 就绪：token 族、`derived-index` 角色、双写/并联 seam
  与「未注册即缺席」语义均已在位；`resolveMemoryStoreBackend({preference:['vector']})` 现在返回
  `undefined` 并有探针锁住。批二只需新增一个后端实现 + 叠加编排，**不需要再改端口形状**。
- **批三** 迁移既有记忆数据 → files 权威层，旧地基物理删除 —— 接入点见第四节。
