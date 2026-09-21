# 搜索续接与异常收尾加固

## 接入位置与结果

本轮继续修改正式 `AdvancedSearch → RuntimeSession → ActLoop → SearchActivation` 链路。搜索与普通子 Agent 的预算仍由父任务的 ContextView 统一记账，实际模型调用仍走原 ModelDriver。

### 搜索执行权

报告存入父任务并登记到搜索状态时，仍保留当前 activation 和 expiresAt。协调器随后取消迟到派发、处理未使用的收尾预算、关闭内部会话，最后按 activation 身份清理持久执行权。同一实例还有活动搜索时，即使期限刚好经过，也不能同时在该实例再次打开该会话。

关闭完成前且持久租约仍有效时，另一个协调器通过同一存储读取到活动 claim，续查返回 SEARCH_BUSY；当前实例的搜索能力范围也保留到关闭结束。清理只关闭自己登记的活动，不会在预算预留失败、尚未打开会话时按 id 关闭其他会话。

预算释放、内部会话关闭、持久 claim 清理分别尝试。任一清理失败都会返回 SEARCH_CLEANUP，保留原始失败及其他清理错误，错误消息也包含具体原因，便于从 Kernel 回执查看。已发布的报告仍保存在父任务的归档中，清理失败不会伪装成整个 search 调用成功。

### 模型派发与预算

`utils/model-budget.ts` 的 `reservedModelStream` 由 `SearchActivation` 和 `BudgetedModelDriver` 共用。预留父预算后再次检查取消；确认预留成功但尚未派发的调用会归还预算，然后报告取消。检查与开始迭代模型流之间没有额外 await。

如果这次归还失败，返回 MODEL_RESERVATION_RELEASE，同时保留取消原因与归还错误。已经派发的模型请求不按取消自动退款，缺少 Provider 用量时继续保留未知。

RuntimeSession 在父脚本结算前，按 sessionId + executionId 等待自己发起的搜索完成清理，随后才能结束 ContextView 的任务租约。宿主 execute 和主模型循环共用这条路径，异步脚本仍按自己的执行身份等待。

预算预留已经落盘但 Promise 尚未返回时，模型取消不能提前结束账务。共享派发函数登记本地结算 Promise；SearchActivation 和 BudgetedModelDriver 的关闭会等待已开始的预留/退款及用量记录。普通子 Agent 的会话关闭也同时执行 BudgetedModelDriver.close，父调度器随后才能释放根任务租约。等待范围是本地账务与搜索生命周期；忽略取消的远端模型流仍由原有有界流读取器退出等待。

SearchActivation 持有自己的关闭信号。关闭时取消尚在估算或等待预算的调用，禁止新来源探索，并将关闭 Promise 缓存：重复或并发 close 都只释放一次未使用的收尾预留；释放失败也不会因重复 close 而重复扣减父任务账本。

模型流不再重复保存没有变化的 SearchState。真实来源查询/读取仍在原位置持久化状态；模型用量仍进入父任务总账。这同时避免已经收尾的模型流迟到后尝试写回旧恢复状态。

### 来源范围变化

续查按来源身份比较集合，而不是只比较数量。只要移除了旧来源，或者已有证据变得不可访问，就清空候选并写入历史重置。等量替换来源时，旧候选正文和自由历史不会进入新请求。只增加来源且旧证据仍有效时，可以继续使用现有历史。

## 文件与契约差量

| 文件 | 职责变化 |
| --- | --- |
| `velaros/src/impl/AdvancedSearch.ts` | 发布到关闭期间的 claim、逐项清理、错误上报和来源集合检查 |
| `velaros/src/impl/SearchActivation.ts` | 关闭信号、收尾预算幂等释放、实际派发前的取消检查 |
| `velaros/src/impl/BudgetedModelDriver.ts` | 普通子 Agent 共用预算预留与取消处理，关闭等待账务结算 |
| `velaros/src/impl/RuntimeSession.ts` | 父脚本结算前等待所属搜索清理 |
| `velaros/src/impl/ComposedRuntime.ts` | 装配搜索结算端口与子驱动关闭 |
| `velaros/src/utils/model-budget.ts` | 无实例状态的共享预算派发边界 |
| `velaros/src/interface/internal.ts` | 内部搜索结算端口和子驱动关闭合同 |
| `velaros/test/advanced-search.test.mjs` | 来源变更、异常清理、竞争续查、取消及正式 ScriptAct 故障回执 |
| `velaros/test/act-children.test.mjs` | 普通子 Agent 取消时的父预算结算 |

公开 provides/requires 的成员和签名保持当前合同。`StandardModules.ts` 没有更改，模型可见工具、参数、schemaRevision 继续为当前版本；故障路径新增明确的 SEARCH_CLEANUP / MODEL_RESERVATION_RELEASE 错误码。当前 Velaros 0.3.0 变更集继续使用同一套 Runtime、存储与权限边界。

## 验证

新增 15 项回归测试。修复前复现了提前释放 claim、清理错误丢失、错误关闭未打开会话、取消后仍派发、重复归还等失败。

- 搜索测试从 17 项增至 31 项，子 Agent 测试新增 1 项。两处取消竞态均先在正式调用链复现额度残留，再验证修复。
- 最终相关 Node 回归 **203 项通过、0 失败、0 跳过**，包含 Velaros 的 13 个正式链路测试文件、Context 的两组测试及 Act 评测适配器；本次运行约 28.3 秒。
- Velaros build、typecheck、module-ownership、agent-arch、agent-public-api、agent-schemas、conversation-semantics 均通过。
- AdvancedSearch、SearchActivation、BudgetedModelDriver、model-budget 四个生产文件的显式 ESLint 通过；git diff --check 通过。
- 根目录完整 check、产品验收和真实 Provider 质量评估尚未执行。

## 故障边界

存储不可用时不能保证 claim 或预算立即持久释放。运行时尝试其他清理并明确返回失败，残留 claim 受原有期限与 CAS 归属保护；不会把失败解释成已经释放。本地存储操作若一直不返回，账务收尾也需要等待；当前存储接口没有可安全强制中断已提交事务的机制。底层驱动若忽略取消，运行时可以拒绝迟到响应和新的派发，无法撤回已经发出的远端请求。

本轮未调用真实 Provider，测试使用受控驱动、真实 SQLite、正式隔离脚本执行和 Kernel 回执。未提交或推送。

修改前备份：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/act-search-lifecycle-before-ihcwkio0/source.tgz`。
