# Act 多 store 升级差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

日期：2026-09-21。范围：持久空间创建与目录、显式共享、多空间订阅、显式初始化、唯一模型入口。

## 实际完成

模型统一从 `velaros:system` 导入 `store`。同一 Agent 可以使用多个空间，不同 Agent 通过获配的空间协作。创建者默认拥有自己的空间，宿主显式 grants 可进一步收窄拥有者权限，其他主会话由宿主 grants 授权，业务子任务由 start.stores 显式授权。空间名称不代表身份，持久 UUID 和宿主边界共同确定访问位置。

| 操作 | 本轮职责与影响 |
| --- | --- |
| store.create | 创建独立空间并保存原调用的幂等回执；执行模式，返回 id、说明及权限 |
| store.list | 先按拥有者和授权 ID 过滤，再分页返回空间目录；观察/执行模式 |
| store.keys | 对应空间内按授权前缀分页列出对象元数据；观察/执行模式 |
| store.get | 按 store 和 key 读取当前 JSON 对象及版本；观察/执行模式 |
| store.set | 带版本前提完整替换，冲突先重读，自己的写回推进决策依据；执行模式 |
| store.remove | 删除对象并保留递增版本墓碑；执行模式 |
| store.watch | 为指定空间替换持久关注项，空集合取消，相同声明保持确认位置；执行模式 |
| agents.start | 新增可选 stores 数组，显式向子任务授予父范围内的空间与前缀 |
| agents.resume | 按持久 AgentJob.stores 重建共享环境，启动前重新核验父权限及 profile |

完整合同有七项，可写已有空间的合同有六项，只读合同有四项。投影共享 StoreModule 实现，模型始终使用一个 store 成员。子任务没有创建空间的权限；没有获配空间的子任务、搜索和整理会话不装配此成员。

## 真实改动位置

- `packages/context/src/impl/LocalStoreStorage.ts`：使用 LocalContextStorage 的 SQLite 连接和 store_* 数据表，包含空间目录、创建回执、对象、事件与订阅；支持目录授权过滤、分页、创建幂等与归档。
- `packages/context/src/contract/store.ts`、`src/interface/requires.ts`、`src/index.ts`、`src/contracts.ts`：StoreStorage、对象与变更数据，以及 StoreCreate/Descriptor/Directory。ContextStorage.stores 为统一存储端口；StoreMutation.store 表达对象所属空间，StoreCreate.scope 表达宿主边界。
- `packages/context/src/utils/store.ts`：复用原 JSON 稳定编码、大小、前缀与关注项校验。
- `packages/velaros/act/system/impl/StoreSession.ts`：每会话多空间授权、创建、分页、委托校验、订阅恢复、跨空间依据与公平投递。StoreConfiguration 是固定的宿主配置，StoreGrant 共用 AgentStoreGrant 数据合同。
- `packages/velaros/act/system/impl/StoreModule.ts`、SystemModules、SystemCatalog、constants/provides/requires/index：单一模型成员及三种实际合同投影；系统合同代际 17。系统保留身份继续受原装配保护。
- `packages/velaros/act/system/store-template.js`、`store-write-template.js`、`store-read-template.js`：真实合同对应的模型使用模板，由 modules.describe 读取。
- `packages/velaros/act/runtime/contract/requires.ts`：VelarosRuntimeOptions.stores(sessionId) 返回 StoreConfiguration；AgentProfile.stores 控制是否允许对子任务共享。
- `packages/velaros/act/runtime/impl/ComposedRuntime.ts`：按主线或显式共享的范围装配，子任务启动与续跑重新核验；异步初始化通过同一会话的在途 Promise 合并，关闭等待初始化收束。
- `packages/velaros/act/runtime/impl/RuntimeSession.ts`：实际分区改为 runtime.stores，多空间共用总投递额度；依然由 ProviderRequestCompiler 最终计量，按已接受帧确认并唤醒活动等待。
- `packages/agent/src/contract/delegation.ts`、`src/impl/AgentSupervisor.ts`、`src/index.ts`：AgentStart/AgentJob 增加可选 stores，共用 AgentStoreGrant，派发时复制并持久化，续跑沿用原授权数据。
- `packages/velaros/act/agents/impl/AgentsModule.ts`、`template.js`、runtime schemas：真实 JSON 输入/返回合同及模板支持 stores。Runtime 合同代际 12 → 13。
- `scripts/ownership/governed-modules.mjs`、`scripts/script/act-catalog.mjs`、Act README、模块卡与不变量：登记重命名后的实现、合同投影和验证承诺。

本轮没有新增 Runtime。ScriptAct、Kernel 权限与调用日志、ContextStorage、ProviderRequestCompiler 和现有子任务调度器继续承担各自职责。

## 数据与授权

1. 主线默认使用 `scope: session:<id>` 作为宿主边界，可创建多个独立 store。跨主线共享由宿主提供相同 scope 及具体 grants，空间 ID 本身不授予权限。
2. 新会话从已有拥有者空间与显式授权建立目录；没有空间时目录为空。create 原子生成持久 UUID、目录与创建回执。
3. 对象、事件、订阅和提交回执按 store ID 隔离，存放于 store_* 数据表；目录使用 scope 表达宿主边界。
4. 模型对象调用指定 store，空间目录使用 list，对象目录使用 keys。写入和新订阅要求空间已创建且处于活动状态。
5. 宿主通过 stores 回调配置主线，通过 start.stores 配置子任务共享；会话身份、store ID 和实际读写授权共同决定订阅身份。

## 投递、生命周期和边界

runtime.stores 自动提供最多四个空间的目录页和 nextAfter。多个空间共享每帧最多八个事件或缺口的额度，每空间每帧至多一个合并对象事件；接受响应后逐空间确认并轮换下一起点。每个订阅的代次和已确认序号独立持久化，失败后可以补收。

对象正文通过 get/observe/output 按需进入上下文。所有目录与通知仍计入真实请求预算。事件只表示对象变化，确认表示模型已看到，业务处理成功需另外保存状态。相同键在不同空间使用不同的读取依据身份。

创建者每个宿主边界最多持有 128 个活动空间，归档释放活动额度；每会话最多显式获配 128 个空间。对象最大 256 KiB，订阅最多 64 个选择项，每空间保留最近 4096 条变更，缺口报告 gap，跨连接等待每 250 ms 检查。目录和持久对象独立于上下文租约。

宿主通过 `storage.stores.archive(scope,id)` 撤回空间访问并保留原文和回执。已经结束的运行由宿主再次 submit，变化只唤醒已经活动的等待。不同对象及外部操作分别提交；JSON 中的引用继续受原材料权限约束。

## 公开 API 基线与既有验收调整

Agent 的公开变化为 AgentStart.stores、AgentJob.stores 两个可选字段，以及 AgentStoreGrant 新类型。在根入口和 contracts 入口各体现一次，共六项声明变化；已有字段和方法保持兼容。按仓库 API 基线策略，将 Agent 5.0.0 升为 5.1.0，同步 bun.lock 的对应 workspace 版本，并更新 baselines/agent/public-api.json。基线更新明确标记为经审查的 additive：新增类型两项、包含可选字段的声明变化四项、移除零项。

原 state 验收整体迁移到 store.test.mjs，保留并发、事务回滚、重启恢复、权限、观察只读、决策依据、丢失回执核对和等待唤醒的行为承诺。调整点：

- 单会话单空间改为显式多空间，测试夹具提供初始 store；另有真实 ScriptAct create 验证。
- 子任务原隐式继承父空间改为 start.stores 显式共享，增加未授权空间不可发现、无共享能力、续跑授权及启动前拒绝的验证。
- 单页 changes 改为按 store 分组的变化页数组，断言仍检查真实模型请求、预算和确认序号。
- system INV-3 可见操作数 14 → 16，原因是空间 create 和目录拆分；runtime INV-2 宿主注册表增加 write 投影。单一模型入口承诺由声明、模板和执行测试共同验证。
- 新增 Context INV-10、System INV-16，覆盖空间身份、目录、归档额度、跨空间隔离、公平投递、初始化与共享。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| Context build / typecheck | 通过 |
| Context Node 测试 | 43/43 |
| Context 通知账本 Bun 测试 | 8/8 |
| Velaros build / typecheck | 通过 |
| Act 全部 27 个 Node 测试文件 | 320/320 |
| store 专项回归 | 29/29，包含在上述 Act 测试中，不重复计数 |
| Provider / MCP Bun 测试 | 23/23 |
| check:module-ownership | 通过 |
| check:agent-schemas / check:agent-arch / check:capabilities-arch / check:act-catalog | 通过 |

本次收拢与稳定引用复验合计 394 项自动化测试通过，Act 目录生成结果为 12 种底层合同投影、54 个投影操作。模型入口使用当前会话实际获配的一份合同。

真实模型评测按用户安排留待后续，本轮未进行真实 Provider 任务或产品端联调。实现使用真实 ScriptAct 执行器、SQLite、Kernel 和 Runtime 的确定性测试，不新增演示运行时。工作区其余在途改动保持原样。

使用说明见 [Act 模型自管理空间](../architecture/act-system-space.md)。

## 2026-09-21 当前契约收拢

用户确认尚无实际使用数据，授权清理 store 历史兼容。对外注入接口 StoreStorage 去掉 adopt，StoreConfiguration 去掉 legacyScope；StoreSession 初始化只核验当前目录和 grants。LocalStoreStorage 的表名统一为 store_*，对象相关字段统一为 store，订阅身份直接使用当前 StoreGrant。七个模型操作及其 schema、声明和模板保持当前合同。

Context INV-10 的历史接管用例调整为“写入与订阅必须指向已创建的活动空间”，保留幂等核对与归档回执断言。System INV-16 的迁移用例调整为“空目录 → 显式创建 → 重启恢复”，继续覆盖并发打开、对象持久化与未确认通知；拥有者授权用例改用当前 store 创建和订阅流程，并验证不同授权的消费者隔离。原因是当前产品从显式多 store 合同开始使用。

本次同时补齐任务稳定引用：ContextTaskState.storeRefs 复用原任务 CAS；StoreFrame.active 自动加入真实模型请求，按预算报告 total/omitted；StoreSession 的创建、使用与共享登记引用，恢复核对也补登创建引用。StoreSessionApi.list 增加 active 过滤参数，frame 增加引用字符预算；StoreModule.list 的 schema、摘要与三份模板同步，SystemContract 升为 17。没有增加模型操作入口。

新增 System INV-17，覆盖超过普通目录四项、结果租约到期、任务继续/重启/切换、真实模型多轮创建而未 output、子任务获配引用、撤权归档过滤、超预算分页找回和并发 CAS 合并。稳定引用只携带真实目录元数据，正文按需读取。创建核对用例增加引用恢复断言。

本次实际复验：Context 43 项 Node + 8 项 Bun、Act 320 项 Node（含 store 29 项）、Provider/MCP 23 项 Bun，合计 394 项通过。Context/Velaros build 与 typecheck、module-ownership、agent-schemas、agent-arch、capabilities-arch、act-catalog 全部通过；新增 INV-17 已登记，差量与新增文件空白检查通过。真实模型评测按用户安排后续执行。
