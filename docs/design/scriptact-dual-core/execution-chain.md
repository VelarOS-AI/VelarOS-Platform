# 当前执行链路

> 历史设计与阶段验收记录。本文中的接口、路径和测试数字对应其记录阶段；当前实现请读 [Act 运行架构](../../architecture/platform-runtime.md)、[模块规范](../../architecture/module-ownership.md)、[系统能力](../../architecture/act-system-space.md) 与 [存储合同](../../architecture/storage.md)。原始输入规格保存在 reference-pack/。

本文描述 `context.mode: 'active'` 的正式代码路径。模式缺省为 off，宿主在装配时显式启用。

```text
宿主 createRuntime → openSession → session.submit(userText)
  │
  ├─ Context：原始用户记录 + 任务检查点 / CAS / lease
  │
  └─ Agent.FoundationAgent
       │
       ├─ 取得或构建当前 ModelView
       ├─ ProviderRequestCompiler.compileModelTurn
       │    结构校验 → 请求指纹 → 实际请求预算 → 审计
       ├─ ModelDriver → 供应商主模型
       │
       ├─ script.run 调用
       │    └─ Velaros.ComposedRuntime → Kernel.OperationRuntime
       │         → Velaros.RuntimeSession → Script.KernelScriptSession
       │         → 原 QuickJS 执行器
       │              ├─ 业务模块 → Kernel → 原领域操作
       │              │              检查 / 持久意图 / 派发 / 回执
       │              ├─ view.request → 下一轮观察需求
       │              ├─ task.update → 模型任务胶囊
       │              └─ artifacts.put / output → 中间材料 / 脚本结果
       │
       ├─ RuntimeSession 汇总真实日志与脚本结果
       │    └─ ContextViewSession.settle → context-pending / needs-reconcile
       │
       ├─ ContextEvidenceBuilder
       │    ├─ 精确需求：直接解析
       │    └─ 语义需求：候选检索 → BoundedContextPlanner
       │                         → 同一 Compiler → 上下文模型
       │                         → ContextPlan 候选选择
       │    → Source 真实读取 → 授权 / 版本 / 指纹 / 预算检查
       │    → CAS 发布 ModelView → 下一轮主模型
       │
       └─ 主模型结束：ContextViewSession.complete
            未决效果 / required 缺口 / 新鲜度检查
            → 可选领域验收器 → 再次验证读集
            → verification + completed / context_blocked
```

## 入口和模型请求

`packages/velaros/src/impl/ComposedRuntime.ts` 只创建一份 Kernel、操作日志与存储装配。`RuntimeSession.ts` 把用户输入交给 `packages/agent/src/impl/loop/FoundationAgent.ts`。原始目标以用户记录持久保存，模型能更新的任务胶囊与原始目标分开。

每轮先取得有效 ModelView，再进入 `ProviderRequestCompiler.compileModelTurn`。编译器保存最终请求快照、核对窗口和输出预留；`packages/model/src/impl/requests/AiSdkModelDriver.ts` 发送这些已编译字节。主核与上下文核共用驱动协议和编译器，使用共享任务帧，按当前计算步骤选择材料。任务预算合并计量。

外部逻辑入口是 `script.run`。AI SDK 传输使用合法的供应商工具名 `script_run`，驱动把结果映射回逻辑入口。上下文角色通过同一传输适配提交 `context.plan`，其调用结果只交给计划校验器。

## 脚本和世界操作

主模型完整响应结束后才执行脚本。Velaros 为调用签发身份；Kernel 校验入口 schema；Script 包负责导入检查、类型检查、绑定和既有 QuickJS 执行。

脚本内部通过 `modules.list/search/describe` 发现宿主挂载的能力，再导入领域模块。每个业务调用重新经过 Kernel 的 schema、绑定、准备、任务写入前提、持久意图、实际派发和真实回执。读取与写入的效果由模块契约声明；领域模块负责自己的条件写与原子性。

`view.sources` 返回当前可用证据源；`view.request` 只登记需求。`task.update` 保存下一目标、假设和问题；`artifacts.put/read` 跨轮保存和召回材料；`output` 是本轮结果的一部分。脚本源码和结果各有持久引用，下一轮看到有界片段，也能召回完整记录。

`RuntimeSession.execute` 在 finally 中从同一操作日志结算。脚本捕获异常不会抹掉失败回执；多操作的成功、失败和未知效果分别保存。未知效果阻止下一次脚本派发，需要宿主调用 `session.reconcile()`，由原模块提供的只读核对器确认世界事实。

## 下一轮上下文

精确请求由 Context 直接处理，上下文模型调用数为零。语义请求先取得授权候选，再进入有界规划器。规划器只能返回候选 ID、表示选择、只读搜索/检查或不足声明，不能调用业务模块。

计划校验后，`ContextEvidenceBuilder` 从 Source 再读取真实正文。Project Source 复用项目内核的路径范围、符号、编码和 revision。证据经授权、内容指纹、版本、容量检查后，`ContextViewSession` 核对任务 revision 与 lease，再发布 ModelView。源变化、范围撤销、预算淘汰都产生失效或明确缺口。

下一轮主核看到：完整用户目标、任务胶囊、强制操作反馈、最近脚本与输出片段、真实证据、覆盖状态、缺口、恢复引用和用量。此前看过的文件不能仅凭历史记忆作为当前事实。

## 停止和恢复

主模型停止输出表示请求完成。Runtime 检查未知效果、required 缺口和证据版本；配置了领域验收器时还要通过其真实检查。验收前后都验证读集。没有领域验收器时，交付状态为 completed / unverified，宿主应消费独立的 verification 事件。

取消与超时会结束等待并保留终态。已经发出的外部操作仍可能形成迟到事实，这些事实可以入日志，不能把任务复活。重启恢复读取现有 SQLite 检查点和 Kernel 日志；日志只有意图、没有确定结果的操作先核对，不自动重复派发。

off 使用既有工作集路径；shadow 同样发送既有工作集，只记录视图观察元数据；active 使用物化视图。宿主直接 `session.run` 可跳过模型验证机制链路，但仍复用同一执行器、Kernel、存储和视图构建。

当前默认 active。script.run 支持源码与自动保存的 sourceRef；12 个领域模块使用统一生成合同。ModelView 的 progress 分别报告代码、输出、证据和图像变化。图像按真实附件块通过同一请求编译和编码边界发送。完整说明见 [Platform 统一执行架构](../../architecture/platform-runtime.md)。
