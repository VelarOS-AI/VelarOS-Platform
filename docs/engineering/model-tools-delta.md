# 模型工具实现差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

本次在已有 Act 链路上完成模型工具装配、公共预算调度及独立上下文整理。实现位置及验收状态见 [接入图谱](model-tools-implementation-map.md)，实际运行说明见 [交付报告](model-tools-report.md)。

## 产品与注入合同

- `VelarosRuntimeOptions.modelTools`：活动树深度、累计会话配额、实际模型请求并发。
- `AgentProfile.budget`：业务子任务及其工具调用的累计模型次数与 token 上限。
- `VelarosContextOptions.maintenance` / `ContextMaintenanceOptions`：独立整理模型及完整可配置档位。默认使用调用者模型的独立会话；false 使用确定性引用降级。
- 导出数据 `ModelToolPolicy`、`ContextMaintenanceProfile`、`ModelToolModelProfile` 与以上配置同源。
- `ActContextPort.maintain?`：安全轮边界的独立整理端口。`pressure?`：叶子工具在容量预警时直接转交付。两个成员都是可选新增；Agent 版本 4.1.0 → 4.2.0，公共 API 基线按 additive 更新，锁文件只同步该 workspace 版本。
- `RuntimeSessionModelTool`：内部专项阶段、材料引用校验及报告校验端口，搜索和整理共享会话实现。
- `ContextMaintenanceHost`：系统模块注入整理请求、状态、复位及材料读取的窄端口。
- 根任务缺省为 10,000 业务回合、24 小时、100,000 次模型调用、100,000,000 token 总额度；窗口按真实模型声明编译。
- 业务子任务缺省为 256 回合、1 小时、512 次模型调用、4,000,000 token；还受祖先剩余额度限制。
- 模型工具树最多 2 层后代，默认 256 个直接工具会话、1,024 个累计后代会话、4 个实际模型请求并发。维护保留叶子会话槽，成本从祖先总账支付。
- 整理缺省为 24 次调用、100 万 token、20 分钟，最后一轮预留 65536 token/90 秒；最多 256 次资料访问和 200 万字符。

## 每项工具变化

系统合同 schemaRevision 11 → 12；实际装配目录和类型声明自动从相同定义生成。

| 操作 | 原因 | 可见者与影响 |
| --- | --- | --- |
| `system.context.request` | 模型可主动委托整理 | 主线、业务子任务；execute-only；持久登记请求，下一模型请求边界消费 |
| `system.context.status` | 模型需要知道整理进度和结果 | 同上；只读；返回请求、回执和当前呈现策略 |
| `system.context.reset` | 模型需要重新展开上下文 | 同上；execute-only；恢复宿主默认呈现策略，原文与笔记保留 |
| `velaros:context-materials.list` | 整理模型需要有界发现父材料 | 仅活动整理叶子；execute-only、只读；固定快照元数据分页 |
| `velaros:context-materials.read` | 整理结论需要真实原文依据 | 同上；按快照作用域、版本及读取预算检查引用 |

`velaros:agents` 仅进入主线能力集合。子 Agent 的配置会排除该身份。搜索只获得证据访问和确定性自管理成员；整理只获得父快照读取和确定性自管理成员。发现卡片、整体模板、类型声明及执行绑定由会话的同一个能力集合生成。

## 机制与失败语义

ModelToolRuntime 共用活动权、持久归属、祖先预算和模型请求队列。排队发生在预算驱动之外，取消尚未派发的调用不会扣祖先调用数。SearchActivation 委托 ModelToolActivation 处理软收尾、最后一轮预留、硬限额、真实用量与退款。

ContextMaintenance 复用 RuntimeSession/ScriptAct，输出结构化补丁。ContextPatchStore 暂存元数据；ContextMaintenanceState 调用已有笔记、输入意图、历史检查点与结果租约验证后，一次 CAS 发布。原文对象仍在同一存储。新用户输入、源码或结果变化使旧补丁失效；预算与心跳变化不会误判材料更新。

ActLoop 在轮边界调用整理，不消费父业务回合或结果租约；随后用同一 ProviderRequestCompiler 重新编译 work 请求。叶子压力触发引用降级及最后交付轮。整理无效有界退化，必需内容放不下时 context_blocked。当前用户图片保持原生附件；省略的观察/结果图片带原文引用和召回入口。

## 验收合同调整

- `context-management` 的 Provider 容量恢复测试现在显式关闭模型整理，验证两次业务请求、一次观察执行的确定性回退。原来的同一业务模型维护轮行为由独立工具接替。
- `context-memory` INV-20 改为独立整理模型生成父笔记补丁；父模型两次请求、整理模型一次请求、父观察一次、父业务脚本零次。原有不重放承诺得到加强。
- 系统 INV-3 的根能力操作数从 21 改为 24，新增三个 context 操作；仍验证模板可检查、可执行。叶子实际获得 21 个确定性自管理操作。
- 搜索生命周期测试补充共用工具管理器注入，原有搜索验收保持。
- 架构门核对实际 search 目录，并登记整理口与共用工具管理器的生产依赖边。
- 安全打包检查新增两份 context 模板的归档存在性。

自动化结果和真实模型评估的边界见交付报告。没有提交或推送本轮改动。
