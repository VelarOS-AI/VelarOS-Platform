# @velaros-ai/workspace 2.0 升级规划

> 主题：**让工作区内核更稳、更快、更适合多 Agent（Durable, Fast, Multi-Agent-Safe Kernel）**
>
> 本文档是给**执行升级的 AI（GPT-5.5）**看的实施规划。请逐阶段、逐任务执行，每个任务都带「现状 / 目标 / 改动点 / 验收标准」。
>
> 状态：规划草案（已确定默认决策，见 §2）。当前包版本：`1.0.0`，目标：`2.0.0`。

---

## 0. 给执行者的须知（务必先读）

1. **这是大版本升级，允许破坏对外类型契约，但不允许破坏「面向模型的工具语义契约」**：
   - ✅ 可以改：内核内部实现、`WorkspaceKernel` TS 类型、错误类型、`packages/workspace` 内部结构。
   - ❌ 不可以改：`ws_*` 这些 agent 工具的**参数语义、调用流程**。工具名已从旧的 `velaros_workspace_*` 收敛为 `ws_*`，不要恢复旧别名或旧长名前缀。桌面端 `src/main/tools/collections/workspace/` 依赖当前常量源。

2. **项目级规则红线（违反会被门禁拦截，且属于明令禁止）**：
   - `preserve-global-extensions`：**严禁**修改 `packages/core/src/extensions.ts`（`Array.prototype.isEmpty/first/last/unique/...`、`String.prototype.*`、`Number.prototype.clamp/...`、全局 `isPresent`、`Log`、`optionalWhen`、`isString` 等）。内核大量使用这些扩展，**继续照常用**即可，不要「等价替换」成标准库写法，也不要在库包入口再写 `import '@velaros-ai/core/extensions'`。
   - `preserve-architecture-checks-consent`：**不要**为了过编译/过门禁去改 `packages/arch-guard-velaros/**`、根目录 `arch-guard.config.mjs`、`.arch-guard/baseline.json` 的语义。如果新代码触发了某条 arch-guard 规则，优先用合规写法解决；确需临时绕行，必须用 `@arch-guard:suspend`（带 `理由：`）并在 PR/回复里说明，不得静默糊墙。
   - `unknown-json-record`：解析 `Record<string, unknown>` / unknown JSON 时，**复用** `packages/core/src/utils/unknownJsonRecord.ts` 里的 `readString/readNumber/...`，不要在业务文件手写 `asRecord`。非渲染进程直接 `import { … } from '@velaros-ai/core/utils/unknownJsonRecord'`。
   - 遇到「规则之间冲突」或「需要改门禁语义」的情况：**停下来，把冲突摊开，交回人类决定**，不要自作主张。

3. **每个阶段结束都要能独立通过测试**（见每阶段的「验收标准」）。完整门禁：
   ```bash
   npm --workspace @velaros-ai/workspace run build
   npm --workspace @velaros-ai/workspace test
   npm --workspace @velaros-ai/workspace run test:eval
   bun run check:architecture   # 架构门禁，必须绿
   ```
   桌面端集成验证也要保持绿：`bun run typecheck` 与 `bun run scripts:run check:architecture`。

4. **代码风格**：内核代码注释用中文，面向模型的工具文案用中文（沿用现状）。不要加无意义的「逐行解说」注释。

5. **两条来自 1.0 交接文档的硬性流程**（违反会导致门禁假绿或漂移）：
   - **schema 契约 fixture 是门禁**：`packages/workspace/test/fixtures/workspace-tool-schema-contract.json` 是 1.0 冻结的模型契约。涉及工具/operation/schema 的改动若导致该 fixture 变化，必须确认是「有意变更」而非「无意漂移」，并保持 compact bundle 体积在预算内（1.0 为 40,000 chars 预算，当前 ~38,590）。
   - **改 core 后必须先 build core**：若改了 `packages/core/src/utils/ToolInputBounds.ts` 等 core 文件，由于 workspace 可能从 dist 引用 core，需先 `npm --workspace @velaros-ai/core run build` 再跑 workspace 测试。
   - 同时遵守 1.0 交接约束：`.tool.ts` 只放工具+schema 结构（工具函数放外部模块）；描述里不得出现静态 workspace 工具名（用 `wsTool.*` 动态常量）；不得恢复旧工具别名；不得把结构化 `editOperationSchema` 拆成模型不可见的散装描述。

---

## 1. 现状速览（执行前先建立心智模型）

核心文件与职责：

| 路径 | 职责 |
| --- | --- |
| `src/core/workspace.ts` | 内核门面 `Workspace`（~1240 行），编排 IO/事务/搜索/证据/git/策略 |
| `src/core/file-store.ts` | 底层文件网关：快照、读、写、删、列目录、gitignore |
| `src/core/lock-manager.ts` | 内存路径锁队列 |
| `src/batch/runner.ts` | 批处理 DAG 执行 + 冲突检测 + atomic 回滚 |
| `src/audit/journal.ts` | 内存审计日志 |
| `src/registry/*` | adapter / patch / validator / fixer / plugin 注册表 |
| `src/plugins/typescript/*` | TS 语法树解析、符号解析、patch 策略、validator |
| `src/velaros/index.ts` | Velaros 桥接（合并 provider、注册工具） |
| `src/agent-tools.ts` / `src/Workspace.tool.ts` | 面向 agent 的工具定义 |
| `src/core/defaults.ts` | 默认策略 `DEFAULT_CORE_POLICY` |

关键事务生命周期：`prepareEdit`（只生成补丁，不写盘）→ `validate`（在暂存内容上跑校验器）→ `applyEdit`（加锁、校验 revision、写盘）→ `rollback`（用补丁里的旧内容还原）。`commit_edit` 把 prepare+validate+apply 合成一步。

桌面端通过 `createVelarosWorkspaceBridge` 接入，把 Velaros 的 policy/approval/fileFilter/secretRedaction/command/telemetry/sandbox/logger 映射为内核 provider。

---

## 2. 已确定的默认决策

| 决策点 | 默认值 | 说明 |
| --- | --- | --- |
| 是否默认持久化事务/日志 | **默认开启** | 新增 `policy.durableTransactions`（默认 `true`），可关。 |
| 持久化存储位置 | `<root>/.velaros-workspace/`（复用现有 CLI 状态目录约定） | CLI 已用 `.velaros-workspace/state.json`（见 `cli/workspace-factory.ts`）；2.0 事务/日志放同一目录的子路径（如 `tx/`、`journal.ndjson`），**不要**新造 `.velaros/`。通过新增的 `JournalProvider` 可被宿主重定向到别处（如系统应用数据目录）。该目录必须像 CLI state 一样被默认 policy/fileFilter 屏蔽，避免被 read/search 扫到。 |
| `.velaros-workspace/` 是否进 git | **自动写入根 `.gitignore`（若不存在该条目）** | 避免污染用户提交；写入要幂等、可关（`policy.manageGitignore`，默认 `true`）。 |
| 文件写入是否 fsync | **默认 fsync**（`policy.durableWrites`，默认 `true`） | 性能敏感宿主可关。 |
| 类型收紧策略 | **分阶段、保证桌面端持续可编译** | 在阶段 4 集中做，配套修改 `Kernel.tool.ts` 与相关测试。 |

> 执行者注意：以上默认值若与用户在实际执行时的新指示冲突，以用户为准；涉及「在用户仓库写 `.velaros-workspace/` 或改 `.gitignore`」这类对用户工作树的副作用，若用户表达过顾虑，需先确认。

---

## 3. 阶段划分与里程碑

- **阶段 1（2.0.0-alpha）**：原子 + 防崩溃写入（§4）。自包含、安全收益最大。
- **阶段 2（2.0.0-beta.1）**：持久化事务 + 崩溃恢复 + 内存治理（§5）。
- **阶段 3（2.0.0-beta.2）**：缓存与性能（§6）+ 性能基准门禁。
- **阶段 4（2.0.0-rc）**：锁加固、可选 fs-watch（§7）+ 类型收紧与内核拆分（§8）+ 可观测性（§9）。
- **阶段 5**：收尾、文档、版本号、preflight:2.0（§10）。

每个阶段建议单独提交/单独 PR，便于审查与回退。

---

## 4. 阶段 1：原子 + 防崩溃写入

### 4.1 任务 A — 文件原子写入
- **现状**：`file-store.ts` 的 `write()` 直接 `await writeFile(abs, content, "utf8")`（约第 460 行），崩溃中途会写坏文件。
- **目标**：写入对单文件是原子的、可选 fsync。
- **改动点**：
  - 改 `FileStore.write`：写到同目录临时文件 `${abs}.velaros-<id>.tmp` → （若 `durableWrites`）`handle.sync()` → `rename(tmp, abs)`。
  - 临时文件失败时要 `rm` 清理，避免残留。
  - 内核/`FileStore` 初始化时清理本根目录下遗留的 `*.velaros-*.tmp`（崩溃残骸）。
  - 给 `CorePolicy` 增加 `durableWrites?: boolean`，`defaults.ts` 默认 `true`。
- **验收标准**：
  - 新增单测：写入过程中模拟异常（mock `rename` 抛错），断言原文件保持旧内容。
  - 新增单测：写入成功后临时文件不残留。
  - 现有所有写入相关测试仍绿（`test/workspace.test.mjs` 等）。

### 4.2 任务 B — `applyEdit` 多文件原子化
- **现状**：`workspace.ts` 的 `applyEdit`（约第 961–1036 行）循环逐个写文件；中途失败已写文件不回滚。
- **目标**：单次 `applyEdit` 做到「全成或全不动」。
- **改动点**（在现有 `this.locks.lock(...)` 锁内）：
  1. **预备阶段**：遍历所有 patch，先 `snapshot` 取当前内容与 revision、做 revision 校验/rebase（沿用现有 `tryRebasePatch` 逻辑），把每个目标路径的「旧内容/旧是否存在」记录到一个 `restorePlan`。
  2. **提交阶段**：再逐个写盘（每个走任务 A 的原子写）。任一步抛错 → 按 `restorePlan` **逆序还原**已写文件（已存在的写回旧内容；新建的删除），然后重新抛出原始 `WorkspaceError`。
  3. 维持现有返回结构（`oldRevisions/newRevisions/rebasedFiles/gitTrackedFiles`）。
- **注意**：与阶段 2 的持久化结合时，`restorePlan` 要在提交阶段**之前**落盘（见 §5），以便进程在写盘途中崩溃也能恢复。阶段 1 可先只做内存版 `restorePlan`，阶段 2 再接持久化。
- **验收标准**：
  - 新增单测：3 个文件的事务，mock 第 3 个 `store.write` 抛错，断言前两个文件恢复原状、抛出 `WorkspaceError`、事务状态不是 `applied`。
  - `commit_edit`、batch atomic 的现有行为不回归。

---

## 5. 阶段 2：持久化事务 + 崩溃恢复 + 内存治理

### 5.1 任务 C — 引入 `JournalProvider` 抽象与默认 FS 实现
- **现状**：`transactions`/`targets`/`evidence`（`workspace.ts` 约 130–132 行）与 `AuditJournal`（`src/audit/journal.ts`）全在内存，重启即丢，崩溃后无法回滚。
- **目标**：事务、旧内容备份、审计日志可落盘并在重启后恢复。
- **设计**：
  - 新增类型（建议放 `src/types/journal.ts`）：
    ```ts
    export interface DurableTxRecord {
      transactionId: string
      status: 'prepared' | 'applied' | 'rolled_back'
      createdAt: number
      appliedAt?: number
      changedFiles: string[]
      // 提交前写入的恢复计划：每个受影响文件的旧内容/是否新建
      restorePlan: Array<{ path: string; existedBefore: boolean; oldContent?: string }>
      patchesMeta: unknown // 足够 rollback 用的补丁元信息
      metadata?: Record<string, unknown>
    }

    export interface JournalProvider {
      append(event: AuditEvent): Promise<void>
      saveTransaction(record: DurableTxRecord): Promise<void>
      markTransaction(id: string, status: DurableTxRecord['status'], patch?: Partial<DurableTxRecord>): Promise<void>
      loadTransaction(id: string): Promise<DurableTxRecord | undefined>
      loadPending(): Promise<DurableTxRecord[]> // status==='applied' 且未确认完成的
      forget(id: string): Promise<void>
    }
    ```
  - 默认 FS 实现（建议 `src/audit/fs-journal.ts`），**复用 CLI 已有的 `.velaros-workspace/` 目录**（见 `cli/workspace-factory.ts` 的 `WorkspaceCliStateDir`），存储布局：
    ```
    <root>/.velaros-workspace/
      state.json             # 现有 CLI 状态（保持不动）
      journal.ndjson         # 追加写审计事件（新增）
      tx/<txId>.json         # DurableTxRecord（新增）
    ```
    - 写 record 用「临时文件 + rename」保证单条记录写入原子（复用任务 A 思路）。
    - `journal.ndjson` 用追加写。
    - **该目录必须被默认 policy/fileFilter 屏蔽**（CLI 已对 `.velaros-workspace/` 这么做了，确保内核侧也屏蔽，避免 read/search/observe 把事务备份当成工作区文件）。
  - 在 `WorkspaceProviders` 增加可选 `journal?: JournalProvider`；`Workspace` 构造时若 `policy.durableTransactions` 为真且未注入，则用默认 FS 实现。
  - `policy` 增加 `durableTransactions?: boolean`（默认 `true`）、`manageGitignore?: boolean`（默认 `true`）。
  - 若 `manageGitignore`，在初始化时确保根 `.gitignore` 含 `.velaros-workspace/`（幂等、不存在才追加）。
- **验收标准**：
  - 默认 FS 实现单测：save → load 往返、并发追加不串行错乱、record 写入原子。
  - `.gitignore` 幂等写入单测。

### 5.2 任务 D — 把生命周期接到持久化
- **改动点**：
  - `prepareEdit`：成功后 `journal.saveTransaction({status:'prepared', ...})`。
  - `applyEdit`：在 §4.2「提交阶段」前 `saveTransaction`/`markTransaction('applied', { restorePlan })`；成功后保留记录，回滚后 `markTransaction('rolled_back')`。
  - `rollback`：旧内容**优先从 `DurableTxRecord.restorePlan` 读**，内存没有也能回滚（实现「重启后仍可回滚」）。
  - `AuditJournal.record` 同时写内存与 `journal.append`（保持现有内存查询接口不变）。
- **验收标准**：
  - 集成测试：prepare→apply 后，新建一个 `Workspace` 实例（模拟重启，复用同一 `.velaros-workspace/`），仍能对该事务 `rollback` 成功。

### 5.3 任务 E — 崩溃恢复扫描
- **改动点**：
  - `Workspace` 构造或新增 `await workspace.recover()` 中调用 `journal.loadPending()`。
  - 对「状态 `applied` 但带有未完成标记」的事务：默认策略可配置——`recoveryMode: 'rollback' | 'report'`（默认 `report`，即只在 `status()` 暴露 `pendingRecovery`，不擅自改用户文件）。
  - 在 `WorkspaceStatus` 增加 `pendingRecovery?: string[]` 字段（向后兼容，可选字段）。
- **验收标准**：
  - 单测：构造一个「applied 中途崩溃」的 record，断言新实例 `status().pendingRecovery` 包含该 tx；`recoveryMode:'rollback'` 时文件被还原。

### 5.4 任务 F — 内存治理
- **改动点**：
  - `targets`/`evidence` 改为带上限的 LRU（可简单实现：Map + 容量上限 + 插入时淘汰最旧），上限走 policy（如 `maxRetainedTargets`，默认 500）。
  - 终态事务（`applied`/`rolled_back`）在内存保留一个窗口后从内存 Map 移除（磁盘 record 仍在）；`getTransaction` 找不到时回退到 `journal.loadTransaction`。
  - 新增 `Workspace.dispose()`：flush 日志、关闭 watcher（阶段 4）、清理。
- **验收标准**：
  - 单测：插入超过上限的 target，断言最旧的被淘汰、总数不超限。
  - `dispose()` 后无未释放句柄（watcher 在阶段 4 接入后一并验证）。

---

## 6. 阶段 3：缓存与性能

### 6.1 任务 G — `SnapshotCache`（内容/哈希缓存）
- **现状**：`file-store.ts` `snapshot()`（约 246–267 行）每次完整读盘 + `sha256`；`search` 对每条命中再 `store.snapshot`（`workspace.ts` 约 332 行）完整重读。
- **目标**：文件未变时复用快照，避免重复读盘/哈希。
- **设计**：
  - 新增 `src/core/snapshot-cache.ts`：键 `(absPath, mtimeMs, size)`，值 `{ sha256, content?, isBinary, adapterIds? }`，LRU 上限（如 256 项，走 policy）。
  - `FileStore.snapshot` 先 `stat` 拿 `mtimeMs/size`，命中缓存则跳过 `readFile`+`sha256`。
  - 写入/删除该路径后**主动失效**对应缓存项（在 `write`/`remove`/`rename` 末尾失效）。
- **注意**：缓存必须以 `mtimeMs+size` 为键的一部分，外部改动改变 mtime 自然失效。不要缓存「不存在」的负结果太久。
- **验收标准**：
  - 单测：同一未变文件连续 `snapshot` 两次，第二次不触发 `readFile`（可用 mock/计数器验证）。
  - 写入后 `snapshot` 返回新内容（缓存正确失效）。
  - 所有现有读/搜索测试绿。

### 6.2 任务 H — AST 解析缓存
- **现状**：`plugins/typescript/ast.ts` 的 `parseTs` 调 `ts.createSourceFile`，在 adapter/strategy/validators 多处被无缓存重复调用。
- **目标**：同内容只解析一次。
- **设计**：在 `ast.ts` 加一个小 LRU（键 `sha256(content)` + scriptKind，值 `ParseTsResult`，上限如 64）。注意 `ts.SourceFile` 可安全复用（只读使用）。
- **验收标准**：单测：相同内容 `parseTs` 两次命中缓存（计数器验证 `createSourceFile` 只调一次）。

### 6.3 任务 I — git 子进程与 gitignore 缓存
- **现状**：`isInsideGitWorkTree()`（`workspace.ts` 约 214 行）每次新建文件 apply/rollback 都 spawn；`file-store.ts` `listFiles` 每目录可能 spawn `git check-ignore`，且 `.gitignore` 每次重读。
- **目标**：减少子进程与重复 IO。
- **设计**：
  - `isInsideGitWorkTree` 结果在内核生命周期内缓存（首次计算后记忆）。
  - `.gitignore` 规则按目录缓存（带 mtime 失效）。
  - `check-ignore` 在单次遍历内缓存结果。
- **验收标准**：单测：多次 apply 创建文件，`git rev-parse` 只被调用一次（mock command provider 计数）。

### 6.4 任务 J — 有上限的并行
- **现状**：`authorizePaths`、`searchViaAdapters`、`FileStore.observe`/`listFiles` 内多处串行 `await`。
- **目标**：在不破坏顺序语义的前提下并行化只读扫描。
- **设计**：新增小工具 `mapWithConcurrency(items, limit, fn)`（放 `src/utils/`），默认并发取 `policy.maxConcurrentBatchTasks`（默认 8）。仅用于**无副作用的读取**（搜索扫描、observe 快照、authorize）。写入路径**不要**并行。
- **验收标准**：搜索/observe 结果与改动前一致（顺序/排序稳定）；新增基准见 §6.5。

### 6.4b 任务 J2 — 流式 `range` 读取（1.0 交接文档点名的优先项）
- **现状**：`file-store.ts` 的 `read()` 按 `range` 读超大文本时，仍会先把完整文件读入内存（`rawContent = snap.content ?? await readFile(...)`）再 `sliceLines`。`maxBytes/maxChars` 前缀读取与 `stat` 已避免整文件进内存，但 `range` 没有。
- **目标**：按行窗口流式读取，不把整文件读进内存。
- **设计**：新增按行流式扫描（基于 `open` + 分块解码，复用 `readLimitedTextPrefix` 的思路），只解码到目标行窗口结束即停止；与现有 `range`/`maxBytes`/`maxChars`/`hasMore`/`nextStartLine` 返回语义保持一致。
- **验收标准**：单测：对一个超过完整读取上限的大文本按 `range` 读取，断言峰值内存不随文件总大小线性增长（用计数器/分块读次数近似验证），返回内容与切行结果一致。

### 6.4c 任务 J3（可作为拉伸目标）— 大文件结构化编辑的分块/streaming patch
- **现状**：prepare/apply、符号编辑与 patch strategy 仍需要完整文本内容（1.0 交接文档 §8 已记录此限制）。
- **目标**：为超大文件引入分块或 streaming patch 策略，避免整文进内存。
- **设计**：先评估范围；文本类（replace_text/anchor/append/prepend）可优先支持基于偏移的局部 patch，符号/AST 类编辑因需要完整解析可暂不纳入。**实现前先确认是否纳入 2.0 范围**。
- **验收标准**：若纳入——文本类大文件编辑不再整文进内存；符号类维持现状并在文档说明边界。

### 6.5 任务 K — 性能基准 + 门禁
- **目标**：固化性能收益，防回退。
- **设计**：新增 `test/perf.mjs`（或 eval 内）：对一个 ~2000 行 TS 文件跑一遍 `read→resolveTarget→buildEvidence→prepareEdit→validate`，断言：磁盘读次数、`createSourceFile` 次数在阈值内。把它接入 `preflight:2.0`。
- **验收标准**：基准测试稳定通过，阈值有注释说明。

---

## 7. 阶段 4a：锁加固与外部变更感知

### 7.1 任务 L — 锁超时与取消
- **现状**：`lock-manager.ts` 的 `lock()`（约 22–31 行）返回的 Promise 永不 reject，无超时、无 abort。
- **目标**：锁可超时、可取消、可回收。
- **设计**：
  - `lock(paths, owner, options?: { timeoutMs?: number; signal?: AbortSignal })`。
  - 超时/abort 时从队列移除并 reject（新增错误码 `LOCK_TIMEOUT` / `ABORTED`，纳入错误类型，见 §8）。
  - `status()`/新增方法暴露队列等待信息。
  - `applyEdit`/`rollback` 调用处传入合理默认超时（如 30s）与 `ctx` 的 abort signal（桌面端 `Kernel.tool.ts` 已有 `ctx.abortSignal`，可在 apply 工具透传——注意保持工具契约不变，仅内部行为增强）。
- **验收标准**：单测：两个重叠锁，第二个带 50ms 超时，断言其 reject `LOCK_TIMEOUT` 且不影响第一个释放后队列恢复。

### 7.2 任务 M（可选）— fs-watch 外部变更感知
- **目标**：外部改动时提前失效缓存、标记目标过期。
- **设计**：`policy.watchExternalChanges`（默认 `false`，避免大仓库 watcher 开销）。开启时用防抖的 `fs.watch` 失效 `SnapshotCache` 并标记受影响 `targets` 为 stale。`dispose()` 关闭 watcher。
- **验收标准**：单测：开启后外部改文件 → 对应缓存失效、目标标记 stale。
- **备注**：此任务可作为拉伸目标，时间紧可后置。

### 7.3 任务 N（拉伸/需确认）— 跨进程建议锁
- 多窗口/多 Agent 在磁盘层互斥。涉及 sandbox/worktree 假设，**实现前需向用户确认是否纳入 2.0**。默认**不做**。

---

## 8. 阶段 4b：类型收紧与内核拆分

> ⚠️ 破坏性变更集中在此阶段。务必**同步修改桌面端**（`src/main/tools/collections/workspace/**`），并保证全仓类型检查与架构检查通过。

### 8.1 任务 O — 清除公开契约里的 `any`
- **现状**：`WorkspaceKernel` 接口（`workspace.ts` 约 58–70 行）暴露 `listSymbols(): Promise<any[]>`、`getJournal(): any[]`；`registerAdapterFactory = (factory: any)` 等。
- **目标**：用真实类型替换。
- **改动点**：
  - `listSymbols(path): Promise<SymbolInfo[]>`（`SymbolInfo` 见 `types/adapter.ts`，按需补 `adapterId`/`path` 字段类型）。
  - `getJournal(): AuditEvent[]`。
  - 注册方法 `registerAdapterFactory/PatchStrategy/Validator/...` 用各自已有类型替换 `any`。
  - `batch/runner.ts` 的 `BatchKernelLike` 用具体方法签名（可引用 `WorkspaceKernel` 子集）。
  - `transactions` Map 的 `as any` 用一个内部 `StoredTransaction` 联合类型替代。
- **验收标准**：`tsc --noEmit` 全仓绿；桌面端 `Kernel.tool.ts` 调用处类型对齐。

### 8.2 任务 P — 错误类型联合化
- **现状**：`WorkspaceError` 用字符串 `reason` 码。
- **目标**：把 reason 收敛为字面量联合类型 `WorkspaceErrorReason`，便于宿主穷举 switch。
- **改动点**：定义 `type WorkspaceErrorReason = 'BASE_REVISION_MISMATCH' | 'PERMISSION_DENIED' | 'SCOPE_VIOLATION' | 'PROTECTED_FILE' | 'INVALID_INPUT' | 'NOT_SUPPORTED' | 'LOCK_TIMEOUT' | 'ABORTED' | ...`，`WorkspaceError.reason: WorkspaceErrorReason`。保留 `toErrorObject` 形状不变（桌面端依赖）。
- **验收标准**：所有 `new WorkspaceError(...)` 调用点 reason 合法；导出该类型供宿主使用。

### 8.3 任务 Q — 内核服务拆分（内部重构，对外行为不变）
- **目标**：把 1240 行 `Workspace` 拆成职责单一的协作者，提升可测性与可维护性。
- **建议拆分**（`Workspace` 仍作为门面，组合下列服务）：
  - `TransactionManager`：prepare/amend/apply/rollback/fix + 持久化接线。
  - `SearchService`：ripgrep + adapter 回退搜索。
  - `EvidenceService`：`buildEvidencePack`。
  - `GitTracker`：`isInsideGitWorkTree`/track/untrack（含 §6.3 缓存）。
  - `JournalStore`：§5 的持久化封装。
- **约束**：不改对外方法签名与语义；逐个抽取并保持测试绿。**这是大改，建议放最后做、独立提交**。如果时间/风险不允许，可只做「方法分组 + 私有拆分」，不强制拆类。
- **验收标准**：所有现有内核测试零回归；对外 `WorkspaceKernel` 行为不变。

### 8.4 任务 R — 批处理 schema 去重
- **现状**：`Kernel.tool.ts`（~2200 行）批处理 op 的 schema 重复声明了 read/search/prepare 等形状。
- **目标**：从单工具 canonical schema 派生批处理 schema，消除漂移。
- **验收标准**：`packages/workspace/test/fixtures/workspace-tool-schema-contract.json` 契约测试更新且通过；schema bundle 预算检查通过。

---

## 9. 阶段 4c：可观测性

### 任务 S — 阶段化 telemetry span
- **目标**：通过已有 `providers.telemetry` 上报 prepare/apply/validate 的耗时、rebase 次数、缓存命中率、锁等待时长。
- **设计**：在内核关键路径包一层计时，调用 `providers.telemetry?.span?.(...)`（若该 provider 接口缺方法，按最小扩展补充类型，不破坏现有）。日志支持按 tx/path/actor 过滤查询（`AuditJournal` 增查询方法）。
- **验收标准**：注入一个 mock telemetry，断言 apply 流程产生预期 span；现有无 telemetry 时零开销、零回归。

---

## 10. 阶段 5：收尾

### 任务 T — 文档与版本
- 更新 `README.md`（能力清单、并发/持久化章节）、`docs/ARCHITECTURE.md`（加 JournalStore / 缓存 / 服务拆分）、`docs/ROADMAP.md`（勾掉已完成项）。
- `package.json` 版本 `1.0.0` → `2.0.0`。
- 新增 `docs/MIGRATION_1_to_2.md`：列出破坏性类型变更（§8.1/§8.2）、新增 policy 字段、`.velaros-workspace/` 行为、如何关闭持久化。

### 任务 U — preflight:2.0
- 在 `scripts/workspace/` 新增 `preflight-2-0.mjs`（参考现有 `preflight-1-0.mjs`），追加：持久化/崩溃恢复测试、原子 apply 测试、性能基准（§6.5）。
- `package.json` scripts 加 `"preflight:2.0"`。

---

## 11. 新增/变更的 `CorePolicy` 字段汇总（供执行者集中实现）

在 `src/types/policy.ts` 与 `src/core/defaults.ts` 增加（均带保守默认，向后兼容）：

| 字段 | 默认 | 用途 |
| --- | --- | --- |
| `durableWrites?: boolean` | `true` | 文件写入是否 fsync（§4.1） |
| `durableTransactions?: boolean` | `true` | 事务/日志是否持久化（§5） |
| `manageGitignore?: boolean` | `true` | 是否自动把 `.velaros-workspace/` 写入 `.gitignore`（§5.1） |
| `recoveryMode?: 'report' \| 'rollback'` | `'report'` | 崩溃恢复策略（§5.3） |
| `maxRetainedTargets?: number` | `500` | target/evidence 内存上限（§5.4） |
| `snapshotCacheSize?: number` | `256` | 快照缓存容量（§6.1） |
| `watchExternalChanges?: boolean` | `false` | 是否开启 fs-watch（§7.2） |

> 默认值的设计原则：**开箱即更安全（持久化/原子默认开）**，但所有新行为都可通过 policy 关闭，保证宿主可控。

---

## 12. 风险与回退

- **R1**：在用户仓库写 `.velaros-workspace/` 与改 `.gitignore` 是对用户工作树的副作用。若用户不接受，关 `durableTransactions` 或 `manageGitignore`，或注入指向外部目录的 `JournalProvider`。
- **R2**：fsync 在某些文件系统/网络盘上慢 → `durableWrites:false` 兜底。
- **R3**：类型收紧（§8）波及桌面端，已在 git 中标记为 `M` 的若干文件需协调修改；务必整仓编译+测试。
- **R4**：内核拆分（§8.3）风险最高、收益偏内部，若时间紧可降级为「私有方法分组」，不强制拆类。
- **R5**：任何触及 arch-guard 插件语义、根配置、baseline 的需要，**先停下交回人类**（见 §0）。

每个阶段独立提交，出问题可按阶段回退。

---

## 13. 执行检查清单（逐项打勾）

- [ ] 阶段 1：原子写入（任务 A）、`applyEdit` 原子化（任务 B）+ 测试绿
- [ ] 阶段 2：`JournalProvider`+FS 实现（C）、生命周期接线（D）、崩溃恢复（E）、内存治理（F）+ 测试绿
- [ ] 阶段 3：SnapshotCache（G）、AST 缓存（H）、git 缓存（I）、并行（J）、流式 range 读取（J2）、大文件 streaming patch（J3，可拉伸）、性能基准（K）+ 测试绿
- [ ] 阶段 4a：锁超时/取消（L）、可选 fs-watch（M）+ 测试绿
- [ ] 阶段 4b：去 `any`（O）、错误联合类型（P）、内核拆分（Q，可降级）、batch schema 去重（R）+ 整仓编译/测试绿
- [ ] 阶段 4c：telemetry span（S）+ 测试绿
- [ ] 阶段 5：文档（T）、版本 2.0.0、preflight:2.0（U）
- [ ] 全量门禁：`build` / `test` / `test:eval` / `bun run check:architecture` 全绿
- [ ] 面向模型的 `ws_*` 工具语义契约未变，且没有恢复旧 `velaros_workspace_*` 别名
