# 给 Codex 的开工指令

请在当前 VelarOS 仓库中实现 ScriptAct 双核 Runtime 的最小可验证版本。先阅读本目录 `DESIGN.md`；详细契约见 `reference/contracts.ts`；验收和实验见 `EVAL_SPEC.md`；控制流见 `ORCHESTRATOR.md`。这些是设计参考，不代表当前仓库中已经存在同名文件或方法。

## 目标

主 Agent 用 JS 组合能力调用并登记 ViewIntent；上下文核按需检索并产生 ContextPlan；Runtime 从真实数据源物化 ModelView，保持权限、版本、预算、操作账本和恢复能力。精确请求不调用上下文模型；语义请求才调用有界 planner。

## 先勘察，再增量实现

先读取仓库级与相关子目录的 AGENTS.md/开发约束、包配置与现有测试命令。定位真实的 Agent Loop、ScriptAct executor、tool/capability broker、provider compiler、上下文块/证据图、ArtifactStore、实验开关和持久化入口。

优先查找但不假定存在：ProviderRequestCompiler、ContextMemoryOS、ContextEvidenceGraph、ContextCodeSnippetPruner、ContextCodeEditRecallGuard、ContextAttentionRouteValidator。旧资料来自 2026-06-17，当前路径可能已经变化。

生成 `implementation-map.md`，写明真实文件路径、已存在接口、复用方案、最小新增项、架构冲突和测试命令。不要只输出计划就结束；在当前用户授权和仓库流程允许的范围内继续完成 Phase 1，再逐步接入 Phase 2/3。遇到缺失安全设施时先完成纯机制实现，并明确阻塞点，不绕过安全边界。

## 必须保持的边界

产品继续依赖 Kernel Client，Mod 继续依赖 Kernel SDK。工具、项目 AST/检索等领域能力装配在 workspace/Mod adapter；通用调度、协议和物化不依赖 Electron renderer 或具体模型 SDK。已有 provider 发送路径必须保持唯一。

新架构不能平行复制现有工具、权限、存储和上下文对象。若参考契约与仓库已有类型重复，用适配层或扩展现有契约，保留语义，不为了名称一致而大范围迁移。

## 第一阶段交付

实现或适配：ViewIntent/ContextPlan/ModelView 的运行时 schema；版本化内存 Source；任务状态机；ArtifactStore；DirectResolver；Materializer；强制操作回执；最终 token gate；fake model/script executor 测试桩。

先跑通无模型端到端用例：读取 v1 -> 修改为 v2 -> 登记 after-step 观察 -> 下一轮只把 v2 当当前证据。再覆盖预算不足、缺失 diff 基线、未知候选、失败回执保留、跨任务 handle 拒绝与取消后迟到事件。

## 第二阶段交付

复用现有安全 ScriptAct 执行设施和 provider，注入虚拟 view/artifact 模块。不要使用 node:vm、AST 黑名单或普通 Worker 独自充当不可信代码沙箱。精确观察走 direct 路径，不得额外启动 Context Agent。

保留脚本中间数据在 Runtime。局部变量不默认跨轮；持久化通过 Artifact 引用。读写都经过 Broker，写操作遵守版本前提和已有 recall guard。

## 第三阶段交付

引入 ContextPlannerPort 与有界只读候选检索，复用关键词/路径/symbol/AST。默认最多 2 次上下文模型调用、6 次检索/检查调用；预算可配置并计入 task 总成本。不要一开始引入模型训练、向量数据库、分布式服务或复杂多 Agent 框架。

Context Agent 只给候选选择和表示计划，不自由编写事实正文。它的所有候选预览必须先做权限与敏感内容处理。非法输出、幻觉 ID、超时和预算耗尽均降级到安全 direct view 或明确 blocked。

## 不可违反的不变量

- World result、Runtime state 与 ModelView 不得混为同一对象。
- 主核和上下文核不共享无限追加的 messages。
- ViewIntent 是请求，不能提升权限或覆盖硬预算。
- “之前看过”不等于“本轮仍在上下文”；没有基线的 diff 不满足完整当前证据要求。
- 不宣称跨文件/网页/远端服务全局事务；部分成功真实保留。
- 外部写结果 unknown 时先 reconcile，禁止自动重放整段脚本。
- Runtime 失败、拒绝、变更和 required 缺口不能被模型筛掉。
- 下游二次裁剪必须更新覆盖状态，不得造成假满足。
- final 是完成请求，测试证据过期或关键结果未定时不能假称验证通过。
- 新模式 off/shadow/active 可回退；shadow 不重复执行世界操作。

## 测试与交付

按照 DESIGN.md A01-A28 分批增加真实测试。`reference/smoke.test.cjs` 只是局部契约示例，不能替代这些集成测试。使用仓库现有 test/typecheck/architecture/lint 命令，记录实际命令、结果和未覆盖项。

完成后输出：改动文件清单、实际接入路径、运行方法、feature flag、通过与失败测试、尚未完成的阶段、适配器一致性保证、已知安全限制和评测导出位置。不要把“类型通过”或“一次 demo 跑通”当作整个系统已经完成，也不要伪造模型评测成绩。
