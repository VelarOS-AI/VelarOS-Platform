# Act 持久协作交付差量

本轮以现有 ScriptAct → Kernel → ContextStorage 为唯一执行和存储链，补全共享事件、子任务交互、环境续跑、材料共享和任务引用整理。

## 实际入口

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 持久合同 | `packages/context/src/contract/store.ts` | JSON 对象、独立消息、订阅、投递游标、处理确认 |
| 唯一存储端口 | `packages/context/src/interface/requires.ts` | StoreStorage 消息操作与跨连接等待 |
| SQLite 实现 | `packages/context/src/impl/LocalStoreStorage.ts` | 对象、消息、调用回执事务；序号、确认和保留窗口 |
| 会话权限 | `packages/velaros/act/system/impl/StoreSession.ts` | scope/store/前缀授权、材料复制、任务引用与多空间投递 |
| 模型操作 | `packages/velaros/act/system/impl/StoreModule.ts` | 唯一 `velaros:system.store` 成员的 schema、模式、恢复及示例 |
| 子运行控制 | `packages/agent/src/impl/AgentSupervisor.ts` | 请求持久化、唤醒、回答、继续、取消和收尾 |
| 装配 | `packages/velaros/act/runtime/impl/ComposedRuntime.ts` | 父子请求路由、能力配置重新核验、共享预算 |
| 模型帧 | `packages/velaros/act/runtime/impl/RuntimeSession.ts` | 元数据预算、接受帧确认、运行中唤醒、宿主空闲等待 |
| 上下文整理 | `packages/velaros/act/system/impl/ContextMaintenanceState.ts` | 在原快照/CAS 中整理任务 store 引用 |

## 模型 API

从 `velaros:system` 导入 `store`。

- `create({name,description?})`：创建持久空间。
- `list({active?,after?,limit?})`：空间目录；active 为当前任务使用的空间。
- `keys({store,prefix?,after?,limit?})`：对象元数据目录。
- `get({store,key})`：JSON 对象、版本与墓碑。
- `set({store,key,baseRevision,value,event?})`：替换对象；`event={topic,value}` 可与对象在同一个事务提交。
- `remove({store,key,baseRevision})`：删除对象，保留版本墓碑。
- `watch({store,keys?,prefixes?})`：对象状态关注；同一键在一页中合并为最新变化。
- `publish({store,topic,value})`：逐条持久消息；同主题的不同调用保持独立。
- `subscribe({store,topics,after?})`：替换主题前缀订阅。首次省略 after 从当前消息头开始；相同声明保留原游标；`after:0` 显式补读；空 topics 取消。
- `events({store,after?,limit?,pending?})`：分页读取当前订阅范围的消息正文。默认只读未处理消息，`pending:false` 可重读保留窗口内已处理消息。
- `ack({store,ids})`：按精确消息 ID 确认业务处理完成。
- `share({store,key,baseRevision,ref})`：把当前会话原文复制为该键的共享材料。
- `read({store,key,offset?,limit?})`：分页读取共享材料。普通对象中的跨会话引用不会成为访问授权。

`get/list/keys/events/read` 可用于 observe；其余操作只允许 execute。只读投影没有 create/set/remove/publish/share 的发现项、类型声明与调用入口，仍可维护自己的订阅和确认。

对象键和消息主题复用同一套空间 read/write 字面前缀权限。主线向子任务传 `stores:[{store,read,write}]`，Runtime 验证为父权限子集。获配空间 ID 和来源引用都不能自行扩大权限。

## 消息的生命周期

1. 生产者提交持久消息和操作回执，完成事务后再发进程内提示；另一连接通过持久消息头补收。
2. Runtime 将消息 ID、序号、主题、生产者、时间和待处理数量放入 `runtime.stores.messages`，正文按需读取。
3. 模型响应被接受时，只推进那一帧的订阅投递游标。模型失败或重启时，未接受帧仍会投递。
4. 模型处理业务后调用 ack。未处理消息保留在 events 的待处理查询中，不依赖脚本输出租约。
5. 每个空间保留最近 4096 条消息，单条正文最多 16 KiB；窗口缺口明确返回 gap。gap 需要业务核对来源，不能据此声称处理成功。对象正文和共享材料原文保持持久。

幂等保证针对同一 Kernel 调用身份。模型重新写一段 publish 脚本会得到新的调用身份并产生新消息。业务执行需要自己的幂等键或先核对回执；外部操作及消息确认不构成一个全局事务。

## 子任务协作

`velaros:agents` 提供 start/resume/status/wait/reply/send/cancel。业务子 Agent 具备 `velaros:interaction` 的 ask/confirm/capability，发出的请求由宿主绑定父身份；专项搜索、整理叶子不会获得该控制面。

- 子任务提出问题后，Supervisor 将请求写入父任务的最新 `AgentJob.pending`，再唤醒 wait 和主循环等待。请求同时保留在子运行事件日志中。
- 主模型在下一帧的 children 中看到请求身份、类型与问题，通过 `reply({id,requestId,value})` 回答。答案绑定真实 runId，重复、陈旧或跨父任务回答拒绝。
- reply 等待原事件流完成父状态更新，再返回；紧接着调用 wait 不会再次得到刚刚回答的请求。
- capability 用于申请能力，答案本身不授权。子任务先收束当前阶段，父任务调用 `resume({id,input,profile?,writes?,stores?,materials?})`，Runtime 在模型启动前核验新环境。
- resume 保留 sessionId、历史材料与已用预算；空 writes/stores 撤回相应范围。活动子任务不能同时重装环境。子 Agent 仍不能派发子 Agent。
- 重启后的 running/waiting 子任务为 interrupted；原 Promise 不复活。宿主 reconcile 核对未决效果后，显式继续；不重跑整段旧脚本。

## 等待与任务生命周期

活动主线等待后台脚本或子任务时，相关 store 变化、消息或子任务问题可以触发下一轮。已结束的会话可由宿主调用 `session.waitForChanges(signal)` 等待持久通知，然后按产品任务策略调用 submit。waitForChanges 不计模型调用，支持取消，关闭会话时释放等待；它不会自行重启已完成或取消的任务。

## 材料和上下文

share 使用现有 ContextStorage 原文存储，复制到由 scope/store/key 推导的空间，并保存原始来源元数据。材料正文有记录索引保护，不因源会话整理或输出租约消失而回收。read 从实际键绑定的空间读取，不能通过复制某个私有键的 JSON 描述符读取该键正文。共享源码作为材料返回，执行仍须通过接收方自己的 ScriptAct 检查。

`ContextTaskState.storeRefs/releasedStoreRefs` 管理自动展示。整理快照携带 storeRefs，补丁可提交 `releaseStoreRefs`，在原有整组 CAS 中退出 active 任务驻留列表；普通空间目录和相关消息仍按各自规则呈现，数据、权限和订阅保持各自生命周期。实际再次使用该空间时自动激活。引用变化参与整理版本校验。

LocalContextStorage 使用统一记录索引；CAS 只写发生变化的记录，元数据更新不重写历史正文目录。完整 load 仍返回记录元数据，尚不能据此宣称长期海量会话的常数成本。

## 接口和验收调整

- Context `requires.ts` 的 StoreStorage 新增 publish/subscribe/messages/delivered/acknowledgeEvents/waitEvents；receipt 扩展为对应持久回执；StoreMutation 新增可选 event。
- Agent `provides.ts` 新增 reply；wait/waitAny 可因请求返回；resume 使用唯一结构化 AgentResume。
- Agent `requires.ts` 的 ActChildSession 增加 answer。宿主子会话适配器必须提供该方法。
- VelarosSession 新增宿主 waitForChanges；InteractionHost 补齐 capability/detail；StoreSession 和 ContextPatch 对应扩展。
- Agent 采用 6.0.0，Context 0.9.0，Velaros 0.5.0；Agent 公共 API 基线按 breaking 变更审核更新。System schema 18、Runtime schema 14。
- 系统目录验收的当前总操作数由 16 项升级为 22 项；store 固定操作清单验收由 7 项升级至 13 项，只读投影由 4 项升级至 8 项，保留不应发现写操作的断言。
- 存储验收使用正式索引格式，验证引用、跨连接 CAS 和元数据更新不重写历史；数据迁移不再是当前存储契约。
- Agent mock 增加 answer，resume 测试改用结构化输入；身份、配额、取消及失败收尾承诺保持。

## 验证记录

本轮实际完成：持久消息与状态事务、授权消息订阅/确认、父子提问答复、同会话环境续跑、共享材料、任务空间引用整理、活动与空闲等待，以及上述恢复和边界测试。

| 验证范围 | 结果 |
| --- | --- |
| Context Node 自动化 | 48 通过 |
| Context Bun 自动化 | 8 通过 |
| Agent 自动化 | 15 通过 |
| Velaros Act，27 个测试文件 | 328 通过 |
| Provider 编译与 MCP 适配器 | 23 通过 |
| 合计，不重复累计复跑 | 422 通过，0 失败 |

Context、Agent、Velaros 构建与类型检查通过。module-ownership、agent-schemas、agent-arch、capabilities-arch、act-catalog、Agent public-api 和改动文件空白检查通过。自动生成的 Act 清单包含 12 个模块、72 个操作。

边界：真实 Provider/模型效果评测按用户决定另行执行；确定性驱动测试不等于真实模型效果。长期海量会话、持续高流量事件的压力测试尚未完成，不能从这些功能测试推出吞吐或无限期保留承诺。宿主唤醒接入点已提供，运行中的提示和任务自动启动属于不同操作。
