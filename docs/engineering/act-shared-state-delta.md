# Act 持久共享状态差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

日期：2026-09-21。实现位置：VelarOS-Platform。范围：持久 JSON 对象、版本前提、共享范围、恢复通知及现有 Act 主链装配。

## 完成行为

模型从 `velaros:system` 导入唯一 `state` 成员。五个操作来自同一 StateModule 实现：

| 操作 | 输入 | 返回 | 模式与原因 |
| --- | --- | --- | --- |
| get | `{key}` | 当前对象或 null；对象包含 key/revision/deleted/value/updatedAt/actor/sequence | observe/execute；持续观察最新数据 |
| list | `{prefix?,after?,limit?}` | `{items,nextAfter}`，items 为元数据 | observe/execute；发现对象而不灌入正文 |
| set | `{key,baseRevision,value}` | 提交后的对象 | execute；有版本前提的完整替换 |
| remove | `{key,baseRevision}` | 保留递增版本的墓碑 | execute；旧版本不能覆盖重建对象 |
| watch | `{keys?,prefixes?}` | `{revision,after,keys,prefixes}` | execute；替换持久关注集合，重复声明保留游标，空集合清空 |

主模型、业务子 Agent 与宿主可以围绕同一个结构化对象协作。宿主固定 scope、读写前缀和 actor，业务子 Agent 默认读取父范围，只写 `agents/<job.id>/`；显式授权只能在父范围内缩小或选择。只读会话的真实合同只有 get/list/watch。搜索和整理会话保留各自专项能力。

状态提交自动生成变更通知。通知通过下一轮 `partitions.runtime.sharedState` 交付：对象位置、版本、删除标记和来源，正文由 get/observe 读取。活动主线等待子任务时可以被相关变化唤醒。对象、变更、订阅和确认进度跨 Runtime 重启持久化。

## 文件与复用

| 文件/范围 | 本轮变化 |
| --- | --- |
| `packages/context/src/impl/LocalSharedStateStorage.ts` | 在现有 SQLite 连接内新增共享对象、空间序号、变化、订阅和提交回执；事务、CAS、墓碑、幂等写入、分页、保留窗口、等待 |
| `packages/context/src/impl/LocalContextStorage.ts` | 构造并提供 shared 端口，与上下文使用同一连接和关闭生命周期 |
| `packages/context/src/utils/shared-state.ts` | 纯 JSON 校验、稳定编码、大小限制与前缀选择校验 |
| `packages/velaros/act/system/impl/StateSession.ts` | 固定授权空间，按会话及授权派生订阅身份，过滤元数据、等待与确认 |
| `packages/velaros/act/system/impl/StateModule.ts` | 五个真实操作、schema、模式、Kernel 读依据与持久提交核对 |
| `packages/velaros/act/system/state-template.js`、`state-read-template.js` | 通过 modules.describe 返回符合实际授权的使用模板 |
| `SystemModules.ts`、`SystemCatalog.ts`、系统 constants/provides/index | 系统保留身份、单成员合同投影、发现与声明统一；SystemContract 14 → 15 |
| `packages/velaros/act/runtime/impl/ComposedRuntime.ts`、`StandardModules.ts` | 主线/子任务授权与注入，复用现有 Kernel 和 ScriptAct 装配 |
| `packages/velaros/act/runtime/impl/RuntimeSession.ts` | 变化分区进入真实请求与 footprint，已接受帧确认、完成前刷新、等待状态变化 |
| `scripts/script/act-catalog.mjs`、`packages/velaros/act/README.md` | 生成当前模块、操作与运行模式清单 |
| `scripts/ownership/governed-modules.mjs`、模块卡与不变量 | 将新增实现登记在现有归属层，明确新增承诺 |

持久提交使用同一数据库事务，进程内快速通知复用 `createTurnContextAppendHub`，跨连接按持久序号补收。调用继续经过原 Kernel schema、模式、授权、调用日志和效果核对。下一轮请求仍由原分区机制与 ProviderRequestCompiler 编译。

## 对外接口变更

- `packages/context/src/interface/requires.ts`：`ContextStorage.shared?: SharedStateStorage`。新增端口 get/list/commit/receipt/watch/changes/acknowledge/wait；适配器提供时才能装配能力，显式要求共享状态而适配器不支持时打开会话失败。
- `packages/context/src/contract/shared-state.ts`：JSON 对象、目录、写入、订阅、变更页与固定边界常量。通过 context 根入口及 contracts 入口转发，node 入口仍复用原 localContextStorage 工厂。
- `packages/velaros/act/system/contract/requires.ts`：`SystemHost.sharedState?: StateHost`，按调用会话解析 StateSessionApi。system 的 provides/index 转发 StateModuleApi、StateSessionApi、StateHost 及 StateAccess/StateGrant/StateFrame。
- `packages/velaros/act/runtime/contract/requires.ts`：`VelarosRuntimeOptions.state(sessionId)` 返回宿主固定的 StateGrant 或 undefined；`AgentProfile.state` 为父空间内的 StateAccess 或 false。默认主线空间为 `session:<id>`，共享项目需要宿主返回相同稳定 scope。
- Runtime 根入口转发 StateAccess、StateGrant。模型始终使用 `import {state} from 'velaros:system'`，具体读写合同由同一实现按授权投影。

状态空间及授权在会话打开时固定；调用仍经过宿主 authorize。自动通知按固定读授权筛选元数据，交付时不会伪造一次 get 调用。授权变化需要用新的会话装配；新的授权内容派生独立订阅身份。

## 一致性、恢复与边界

1. 对象、递增序号、变化和提交回执原子落盘。版本冲突发生在提交前；不自动重跑脚本。相同版本写相同值复用已有对象，不制造变化。
2. get 返回的版本和 set/remove 写回的版本参加 Kernel 读依据验证；自己的成功写回推进同一脚本的依据，外部变化则拦截旧依据上的业务写入。
3. 通知在完整响应被接受后确认本帧 through，后续新序号仍待交付。崩溃前未确认的页可以重复交付，旧订阅代次不能确认新订阅。该确认仅表示模型已看到，业务处理完成可另存状态。
4. 写入已提交而调用回执丢失时，Kernel reconcile 查询持久提交证据确定效果，不重新执行。
5. 每对象最多 256 KiB JSON，键最多 256 字符，最多 64 个关注项；目录每页默认 32、最大 64；每空间保留最近 4096 个变化，每次扫描 256 个，模型帧最多 8 个合并对象事件。gap 明确要求重新读取当前对象。跨连接等待最多每 250 ms 检查一次。
6. 对象和墓碑不随上下文回收；订阅属于会话，跨逻辑任务保持到显式修改。不同键及外部业务操作各自提交，不能依赖跨操作的原子性。
7. JSON 引用是数据，不携带访问原材料的权限；原材料的能力授权与保留规则继续生效。
8. 已结束或退出活动等待的运行由宿主再次 submit。当前通知只推进已经活动的运行，不自动创建新的模型任务。

## 验收与已有用例调整

新增 Context INV-8/9 与系统 INV-13/14/15，覆盖跨连接冲突、回滚、删除重建、调用身份幂等、重启补收、订阅换代、变化保留缺口、取消等待、前缀过滤、只读发现、实际请求预算、父子共享、叶子工具范围、过期依据拦截、自己写回推进依据、未知效果核对及等待唤醒。

已有验收调整：

- system `spec/runtime.test.mjs` INV-3 的标准可见操作数由 9 改为 14，增加 state 五项；原“规范目录、合同与模板同源”承诺保留。
- runtime `test/runtime.test.mjs` INV-2 的宿主注册表期望增加两个状态合同投影；模型仍只得到一个 state 成员。原宿主枚举应反映当前装配，不能固定为新增前的数量。
- runtime `test/support/module-contract.mjs` 将实际状态投影归入 state 成员，继续检查聚合包调用。
- system `spec/acceptance.test.mjs` 增加完整及只读状态模板/schema 一致性；没有放宽已有验证。
- 新增并发通知用例由宿主写入建立事件基线，以单独验证通知确认，不混入执行结果租约的过期依据验证；后者已有独立真实写入测试。

实际执行结果：

| 验证 | 结果 |
| --- | --- |
| Context build、typecheck | 通过 |
| Context 四个 Node 测试文件 | 39/39 |
| Context turnContextStateSource Bun 测试 | 8/8 |
| Velaros build、typecheck | 通过 |
| Act 全部 27 个 Node 测试文件 | 305/305 |
| Provider 与 MCP Bun 测试 | 23/23 |
| check:module-ownership | 通过 |
| check:agent-schemas、check:agent-arch | 通过 |
| check:capabilities-arch、check:act-catalog | 通过；目录 11 个底层模块投影、45 个操作 |

合计相关自动化测试 375 项通过。确定性模型夹具调用真实 Runtime、ScriptAct 子进程、Kernel 和 SQLite。真实模型评测按照用户安排留待后续；本轮没有进行真实 Provider 任务或产品端联调。仓库其余在途改动保持原样，本轮没有提交或推送。

完整使用与装配见 [Act 模型自管理空间](../architecture/act-system-space.md)。
