# 小型观察与动态上下文

本轮保留 observe，限定为持续的小型状态、摘要、差异、引用和显式历史片段。exec 仍执行一次动作、读取普通材料，其真实结果进入增量历史。此设计不证明模型自然选择率或供应商真实缓存命中率。

## 公开控制合同

既有 observe 登记、替换、刷新和清除保持各自含义。新增一轮历史选择，不创建程序、不替换持续观察：

```ts
observe('', { history: { kind: 'list', limit: 10, cursor } })
observe('', { history: { kind: 'read', snapshotId, pointer, offset: 0, limit: 1024 } })
```

`history` 与源码、snapshot、refresh、clear 互斥。选择回执为 `status: 'selected'`、`selectionRef`、`effective: 'next-model-turn'`、`executed: false`；不返回历史正文。下一帧动态材料才是实际交付。公开签名使用的 `ObservationHistoryRequest` 与选择回执从 runtime 入口导出；目录项与局部页是动态材料的内部类型。

`ObservationLimits` 是 Runtime 唯一数值表：当前观察默认展示 2048 个 UTF-16 字符；带历史选择的动态材料总硬限 4096；目录默认 10 条、最多 20 条；局部读取默认 1024、最多 2048 字符。返回页包括准确范围、总长度和后续游标。超过展示预算明确给出 LIMIT 或 unavailable，不把省略正文当作已读；必需材料缺口阻止完成。图片只返回引用，不自动嵌入动态区。

Kernel 的 `OperationLimits.observationChars` 为观察入参与结算载荷提供同一 4096 字符上限，Runtime 的捕获上限引用它。超限返回小型 LIMIT，在 journal 结算前移除大 value、附件和诊断，不能先保存大 capture 再截展示。一次观察执行的聚合业务载荷预算也受此限制；小型生命周期与拒绝回执另计，错误文案有明确截断标识。exec 不受这项观察专用限制。

## 请求、前缀与交付

`ModelTurnRequest` 增加 `dynamic` 与 `protocol`。`dynamic` 包括真实身份、观察文本及必要的完整原生往返；`compiledPrompt` 仅承载稳定 frame。正文预算与完整原生调用协议分别计量，全部内容仍进入模型总预算。

同一编码器的 `layout()` 返回完整 messages、`retainablePrefixLength` 和逻辑历史的 canonical 消息坐标。顺序为完整历史、稳定 frame、待交付观察往返、当前动态材料、本轮协议。Agent 仅保留完整稳定前缀，不切字符串、不保留旧动态正文，不把 SDK 展开后的行号当 canonical 坐标。动态材料不沿用 earlier-frame 正文证明。

原生 observe 的真实 call/result 整组只在动态尾区交付；完整审计仍保存。原生工具与 exec 混批在任何执行前拒绝并要求分轮，避免拆开往返或伪造回执。宿主与文本协议保留既有复合提交的原子性，两类结果分别进入各自区域。响应接纳后才消费待交付选择和往返；取消、协议修复和未接纳响应不提前消费。

完整请求的语义指纹必须包含动态变化。固定 prefixHash 不能代替实际消息前缀证明，也不能用作不同动态请求的响应缓存身份。当前上下文状态与控制标记位于非保留尾区。各 provider 沿实际协议编码，不插入可能提升到系统区的 late-system 消息。

## 归属与持久化

ProgramContext 单独持有当前历史头、内容引用、变化目录、历史选择和待交付往返。RuntimeSession 负责采集、授权核对及展示，RuntimeTrace 只关联实际引用与计量，不重新计算旧采集费用。

历史限定为同 Agent/Session 的当前任务授权范围，绑定任务起点、授权重置水位和完整模块绑定；显式 new task 或授权变化使旧选择失效。核心不引入产品 workspace。普通 memory catalog/read 不把观察档案作为 exec 材料回送。

内容指纹不包含采集时间、执行 ID 和成本，但保留业务值内真实的 revision。连续同值不新建快照；A→B→A 记录本次变化时间并共享真正同值的 A 内容引用。观察 archive 不再复制完整 capture，沿既有会话引用关联权威 journal。索引不累计在 lease-state 数组中，不增加数据库。旧档案不改写，不隐式固定 N 条淘汰；正文沿原会话档案生命周期保留，缺失与不可读状态明确可见。分页返回预算不代表底层对象已经支持物理分段读取。

## 可用性与产品接线

`ShellHostPort.observationSupport()` 报告当前宿主能否构造真实只读约束规格及原因；缺少声明不能默认支持。登记、替换、刷新和重跑需要真实后端；历史索引读取及 clear 不执行 Node，因此不因缺后端一起屏蔽。控制专用 schema 仍从正式 TS 输入类型生成。

Desktop、Workbench、Server 消费同一新固定 Platform 版本，转发支持查询，并保持真实执行时的隔离检查。Windows 当前三产品未注入额外只读后端，不能以普通 exec 回落冒充 observe。macOS/Linux 的支持报告只证明后端可构造规格，不冒称本轮已实测采集。

模型指令说明持续状态关注、操作前后核实、历史局部对比等场景；不要求每轮主动调用 observe，不把大文件、完整 DOM 或作业等待当作使用理由。

授权固定计划目录由实际 observe 程序能力门控，支持时 Node 同样可发现 provider、plan、module 与 operation，不要求模型猜测映射。只允许历史控制或未开放 observe 的会话不展示该目录。

## 文件分组与验证

- Kernel：请求与 layout 类型、编码器、观察调用结算预算。
- Agent/Model：稳定前缀保留、动态往返交接、实际 SDK 展开坐标及当前输入计量。
- Runtime：控制类型和生成面、ProgramContext 历史索引、RuntimeSession 生命周期、ContextMemory 动态投影与证明、RecentContext 历史过滤、RuntimeTrace 引用。
- Execution/Script：真实支持查询与 Node 执行器转发。

本批只验证多轮 A→A→B→A、小内容与局部读取边界、未变去重、真实回执消费、授权失效、动态正文不进入普通历史、前缀字节稳定及完整请求身份变化。沿已有 wire fixture 捕获实际 SDK 请求，记录长度和计量；本地假模型及执行器只证明机制，不证明供应商命中或 Windows 隔离运行。更新 INV-74 的完整帧保留承诺为仅保留稳定区域，保留旧响应和普通 exec 的真实历史。

0.9.3 保持不可变；本轮稳定后统一一次新固定发行，再由三个产品各消费一次。

## 合同差量

| 合同或承诺 | 修改理由与影响 |
| --- | --- |
| Kernel `ModelTurnRequest.dynamic/protocol`、`ModelDynamicInput`、`ModelRequestLayout` 与编码器 `layout()` | 将瞬时观察和控制尾区移出可保留前缀。自定义模型驱动必须使用完整编码消息；只读 `compiledPrompt` 将漏发动态内容和协议。 |
| Agent `frames.project/reconcile` 的 dynamic 与 `stageDynamicExchange` | 最终动态材料与完整原生往返由同一交付证明约束，接纳后消费；投影适配器需要转发新增材料。 |
| Runtime `ObservationHistoryRequest`、选择回执与 `ObservationLimits` | 提供有界的一轮历史选择；不替换持续程序，也不形成普通执行结果。公开 observe 增加 history 分支与 selected 状态。 |
| `ShellHostPort.observationSupport()` 与执行器支持查询 | 缺失真实只读后端时仅允许历史与清除。产品适配器须转发查询，不能宣称普通执行满足只读约束。 |
| Kernel `OperationLimits`、Project 观察读取上限与 Node 观察日志额度 | 在 journal/日志持久化前限制观察业务载荷；普通 exec 沿原有额度。观察超限显式失败，不留下巨大 capture。 |
| Agent INV-48/49/52、Runtime INV-18/74/80/88、Script INV-28 | 以稳定前缀及瞬时动态区替代完整帧保留承诺，补充历史归属、真实只读能力与持久化边界；旧执行与响应档案仍可审计。 |
