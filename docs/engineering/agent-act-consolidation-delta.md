# Agent → Act 实施差量

日期：2026-09-20。工作树交付，未提交 Git。实施基于进入本轮时已有的 ScriptAct、租约、输入归档和高级搜索代码。

## 完成范围

| 原阶段 | 实际交付 |
| --- | --- |
| 1 请求链 | ProviderRequestCompiler 的物化请求核心迁入 Model；使用标准 Web Crypto / 字节编码；Agent 实例化不再创建治理注册表；AI SDK 仍由 Model 持有 |
| 2 运行核心 | ActLoop + ActRunService；steer、输入持久恢复、交互身份、取消关闭、事件重放、跨运行预算延续；等待与中断状态可检查 |
| 3 子任务 | AgentSupervisor + 同一 RuntimeSession 工厂；宿主 profiles、并发与模块写锁、父预算、引用复制及谱系、续跑和取消；搜索仍由相同 Act 循环处理，其来源/软收尾策略独立 |
| 4 领域边界 | shell/sandbox 审批转 Kernel；browser 活动账本转 Context；MCP 连接转 Velaros 并接统一模块；task/interaction/agents 模块；浏览器安全 renderer 事件投影 |
| 5 清理 | Agent src 收敛为 3 个实现类及接口/数据/有界接收；旧循环、工具执行器、治理、workflow IR、Chat/产品 Session 及旧 seam 实现退出；公开 API、版本、锁和架构门更新 |

通用子任务默认由根任务协调；写冲突按模块范围检测。搜索另有候选/读取额度与软收尾政策，二者通过同一 ContextView 原子预留模型预算。此处没有承诺精确到文件的自动写范围推断。

## 实际文件归属

- `agent/src/impl/{ActLoop,ActRunService,AgentSupervisor}.ts`：唯一循环和运行控制。
- `model/src/impl/requests/ProviderRequestCompiler.ts`、`model/src/utils/provider-*.ts`：编译、编码、指纹和验证。
- `context/src/impl/ContextViewSession.ts`：追加用户目标时保留计费；等待/失败续跑继续预算。
- `context/src/impl/TurnContext*.ts`：活动差量与通知；空账本及换代使用稳定 generation。
- `kernel/src/impl/runtime/{ApprovalContracts,DefaultDenyApprovalPort,TaskApprovalState}.ts`：审批合同和账本。
- `velaros/src/impl/{ComposedRuntime,RuntimeSession,StandardModules,BudgetedModelDriver}.ts`：统一装配、权限范围、子模型计费。
- `velaros/src/impl/McpClientConnection.ts`：保留现有 MCP 连接的生命周期行为。
- `velaros/src/impl/ActEventProjector.ts`、`velaros/src/renderer.ts`：区分流预览与已接受事实，按事件 cursor 重建。

## 公共合同变化

Agent 4.0 的根入口提供 createActRunService、createAgentSupervisor；`./contracts` 保留可移植数据。原 `./chat`、`./tool-contract` 消费方需要迁移。Public API 基线记录 43 个新增、1617 个移除声明；这些是工具统计的入口声明项，并非业务能力数量。

Velaros Session 新增 steer、answer、inspect、events、cancel，Runtime 新增 getSession；注入面新增 agents 配置和派发前 authorize。模块范围同时进入发现、脚本检查和 Kernel 派发。

Model 新增 ProviderRequestCompilerApi，verify 是异步指纹验证，快照 schemaVersion=2。Context 新增 appendGoal 及活动账本接口。Kernel 新增 ApprovalPort、ApprovalContractsApi、TaskApprovalStateApi 和对应工厂/默认实例。

版本：agent 4.0.0、velaros 0.3.0、context 0.8.0、model 0.9.0、kernel 0.5.0；平台代保持 0.6。标准模块 schemaRevision=7。锁文件工作区快照同步，冻结安装通过。

## 模型能力逐项差量

所有定义仍集中于 `velaros/src/impl/StandardModules.ts`。

| 能力 | 理由与影响 |
| --- | --- |
| interaction.ask | 等待用户输入，回答绑定本次 run/request；execute-only |
| interaction.confirm | 等待明确确认；不授予真实操作权限；execute-only |
| task.inspect | 读取真实任务状态与模型 capsule |
| task.update | 将模型计划、决定、未解问题集中到已有 capsule；不能覆盖用户原文或宿主政策 |
| agents.start | 命名 profile 派发、并发占位、共享材料校验，返回精确类型句柄 |
| agents.resume | 沿用同一子会话和原文，重新检查当前配置与预算 |
| agents.status | 只读查询真实子状态与结果引用 |
| agents.wait | 等待真实结束，避免模型轮询 |
| agents.send | 新输入进入子运行同一 steer 机制 |
| agents.cancel | 取消并等待收束，保留部分结果 |
| modules.list/search/describe | 按与执行一致的 scope 过滤，禁止目录泄露未授予能力 |
| history.read/checkpoint | 注册为会话策略能力；只在增量历史作用域开放，通用子任务也可使用 |
| createMcpModule | 外部 schema 快照装入同一 Kernel；只读由宿主显式认定，写入缺少授权即拒绝；保留原图附件与未知效果 |

programs/results/inputs/artifacts/execution 的存储权威和租约语义保持当前实现。高级搜索沿现有证据报告和来源授权链运行。

## 测试迁移与理由

逐文件台账：`agent-test-migration.md`。旧循环内部对象、工具驻留、供应商 tool-call 修复和 workflow IR 的断言随对应合同退出；不把删除的测试计入通过数量。

- MCP 连接、手动审批选项、TurnContext 活动账本的原断言迁到新所属包。
- 编译器的字节保留、响应 schema 封存、指纹修改检测迁到 Model。
- 交互身份、重复/迟到回答、抢占、取消和重启改为实际 RuntimeSession 集成验收。
- 子任务 quota、写冲突、父取消、跨范围拒绝、原文共享、根预算计费以及真实脚本类型链直接验收。
- runtime 模块枚举断言增加 task、interaction、history，原因是这些能力进入同一标准目录；实际模型发现仍受 scope 限制。
- 会话租约使用既有 ContextView CAS/期限与续期语义，旧 PID 生存性状态机退出。
- Agent 工具说明、参数、模式验收归到当前 Kernel/Script 声明与 schema；arch/schema/conversation 门改为核查当前生产链和接受事件。
- Mod CLI 明确拒绝含旧 Agent seam 的包，要求将贡献转换为 Kernel 能力及 Context 来源，避免静默忽略扩展。

## 验证记录

第一轮整体验收：Node 核心/上下文/Velaros 173 通过；Bun Agent/Kernel/Model/Provider/MCP/Context 313 通过；Shell/Sandbox/Project/Browser 855 通过、6 项 Windows 专属跳过。合计 1341 通过、6 跳过、0 失败。

编译器改为 Web Crypto、增量子任务历史和最终边界修正后再次验证的结果列在下方最终核验记录。

构建覆盖 kernel/context/model/agent/velaros。门禁覆盖 module-ownership、agent-arch、agent-schemas、agent-public-api、agent-browser、conversation-semantics、model-arch、capabilities-arch、lockfile-consistency；diff 检查无空白错误。

## 交付限制

- 尚未用真实模型 API 验证长期任务、搜索质量与成本；自动化使用受控模型驱动，MCP 连接使用真实本地协议测试服务。
- 产品专有聊天归档、设置和市场需各产品按其原格式适配；本轮没有产品数据库离线导入器。
- Kernel 的既有远端和 Mod 底层验收通过；实际远端设备、第三方 OAuth 服务及动态目录换代仍需宿主联调。
- 共享材料是派发时授权的不可变副本，自动撤销已经交付的快照不在本次实现中。
- 进程恢复保留引用和事实，不透明恢复任意 JS 栈，不自动重放未知效果操作。

本轮修改前源码和文档备份：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/velaros-act-before-kl5nm4dv/workspace-source.tgz`。备份用于保留开始前的 WIP；未执行 reset、批量暂存或提交。

## 最终核验

最终 Node 回归 174/174；最终 Bun 核心回归 314/314；领域回归 855 通过、6 个 Windows 专属跳过。合计 **1343 通过、6 跳过、0 失败**。后续 task schema 单源复用和 renderer 会话隔离又通过 act-children、runtime 定向回归。

model-arch、module-ownership、agent-arch、agent-schemas、agent-public-api、agent-browser、conversation-semantics、capabilities-arch、lockfile-consistency 均通过。标准 schema 版本为 7，Agent 公共 API 基线为 4.0。历史 Agent 重构文档改为指向当前架构、差量和测试台账，避免多份并行规范。
