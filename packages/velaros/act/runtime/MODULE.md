# Act 共享运行时

## 这是什么

把 Agent Loop、ScriptAct、Kernel、ContextStorage 和 ModelDriver 组合成同一执行链。模型自管理操作集中在 system；Runtime 负责会话机制，search 和 agents 提供按需配置的任务能力。

## 提供什么

`createProjectCapabilityModule` / `ProjectCapabilityModuleOptions`：项目能力与真实资源版本的统一装配。

- `ContextMaintenanceOptions`：独立整理模型和可配置档位。

系统模块装配：`modulesModule`、`ModulesHost`、`ModulesModuleApi`。记忆装配接口从 `./act/system` 提供。

入口 `.` 提供宿主会话装配，`./contracts` 提供数据合同，`./renderer` 提供浏览器安全事件投影。

导出的值：`createRuntime`, `createCapabilityModule`, `createShellCapabilityModule`, `createMcpModule`, `createMcpClientConnection`, `createActEventProjector`, `McpLimits`, `ScriptLeaseLimits`, `VelarosRunLimits`, `VelarosRuntimeContract`。

产品及注入接口：`CapabilityContext`, `CapabilityModuleOptions`, `VelarosContextOptions`, `VelarosRuntimeOptions`, `RuntimeModelConfiguration`, `ShellCapabilityModuleOptions`, `VelarosSearchOptions`, `McpAuthorizationProvider`, `McpConnectionSpec`, `McpConnectionOptions`, `AgentProfile`, `VelarosAgentsOptions`, `McpModuleOptions`, `VelarosRuntime`, `VelarosSession`, `McpClientConnectionApi`, `ActEventProjectorApi`。

## 骨干链路

ComposedRuntime 注入端口 → SystemModules 装配自身管理能力，StandardModules 合并任务服务 → Kernel 注册。
RuntimeSession 接受模型响应 → ScriptTurnDecoder 解析 → ProgramContext 保存与检查 → 共享 Script 执行器调用 Kernel → 回执和租约 → ContextMemory 组装 task/workspace/observation/recent/runtime 五分区 → ModelDriver。
search 单元的 AdvancedSearch 复用同一 RuntimeSession；SearchActivation 负责搜索预算、证据校验与软收尾。

## 依赖什么

Agent 的循环与子任务调度、Script 的校验与隔离执行、Kernel 的注册和权限、Context 的可靠存储与证据访问、Model 的 ProviderRequestCompiler。配置统一从 contract/requires.ts 注入。

## 状态归谁

运行状态、源码版本、笔记、结果租约与原始材料保存在现有 ContextStorage。Kernel journal 记录调用事实。每个 RuntimeSession 持有自己的分区投影与进度。

## 生命周期

await createRuntime → openSession → submit/script → close。搜索和子任务结算后释放父预算；关闭会话取消在途调用，再释放绑定与存储。

## 失败语义

完整响应预检失败不派发；正式工作回合缺少控制决策时有界修复，需要用户回答走交互请求，在途后台任务可等待；驱动确认的瞬时模型连接故障在接受响应前有界重试，每次尝试单独归档和计费。未决效果通过 reconcile 核对；取消和恢复沿持久回执收束。超窗进行有界整理，无法满足基础预算时明确反馈。

## 不变量

共 36 条，未验证 0 条。这里统计确定性验收映射；真实任务结果另见交付报告。登记表保留原有行为承诺，并指向实际执行它们的测试文件。

## 非目标

运行时的能力边界由具体模块端口、隔离执行器和 Kernel 的当前授权决定。

## 结构

```text
runtime/
  contract/ provides.ts、requires.ts、constants.ts
  types/ 运行、协议、分区投影与追踪数据
  impl/ 会话装配、协议解析、分区和执行协调
  utils/ 纯计算、schema 共用构造与调节参数
  invariants.md
  test/ 主干集成验收、Provider 与 MCP
  index.ts
  contracts.ts
  renderer.ts
```

## 长期记忆装配

`VelarosRuntimeOptions.memory(sessionId)` 为主会话返回 `createMemoryStore({root}).scope(scope)`。Runtime 打开主会话时固定端口，将 recall/save/remove 合入 `velaros:system.memory` 的实际合同。搜索、整理和业务子任务使用其角色对应的合同；需要的记忆正文可由主线召回为材料后显式分享。长期记忆的文件、索引和生命周期归已有 memory 单元，工作笔记、结果租约与整理仍由当前会话链管理。

## 多空间共享与通知

ContextStorage.stores 支持持久空间。主线默认在 session:<id> 的宿主边界内创建和使用自己的 store；VelarosRuntimeOptions.stores(sessionId) 可以配置 scope、create 和 grants，返回 undefined 关闭能力。跨主线共享由宿主提供相同 scope 及具体授权。主线通过 agents.start 的 stores 数组显式向子任务共享 StoreGrant，AgentProfile.stores=false 可关闭此能力。子任务没有创建权限，续跑重新检查父授权。搜索和整理保持专项合同。

runtime.stores 提供目录第一页和各空间的有界变化，所有空间共用每帧额度并轮换交付。响应被接受后确认对应的各空间序号。活动运行等待后台执行或子任务时也等待相关变化，先到者推进下一轮；关闭与取消释放其余监听。已结束运行由宿主再次 submit。

## 开箱配置

`await createRuntime({workspace, dataDir, model})` 内部装配现有 Project、ContextStorage、Script 执行器和 Provider 驱动。workspace 为已有绝对目录，dataDir 为工作区之外的状态目录。model 既可传现有 ModelDriver，也可传 `{provider, model, baseURL, apiKey, reasoningLevel?, limits?}`。输入、输出与总窗口是宿主采用的运行预算，需按实际服务配置。

工作区预设默认提供 `worker` 子任务、`standard` 搜索档位和按工作区绑定的长期记忆；可用 agents/search/memory=false 关闭。已注入 storage/runner/modules/model 的专用装配仅开启显式配置的模型工具。主模型和支线共用原有 ProviderRequestCompiler、权限检查与可靠存储。

调用 createRuntime 成功后，Runtime 接管存储连接，在 runtime.close 时释放；初始化失败时仅关闭框架新建的连接。session.close 只关闭该会话并撤回缓存，之后 openSession 相同 ID 恢复持久数据。直接调用宿主 script/execute 时先登记用户目标；通常 session.submit 会完成目标归档。


## 持久追踪

`runtime.trace(rootSessionId, {sessionId?,after?,limit?,maxChars?})` 查询原始上下文、回复、脚本和调用回执，并返回根当前任务的 branches 目录。支线由同一根的持久归属记录验证，关闭后仍可查看；读取不会发起模型调用。after 是模型请求记录序号，nextAfter 非空时继续分页；正文按本页共用的 maxChars 截断。运行中的回合应重读，以取得后来发生的响应与效果。精确到某一请求仍可使用 session.trace(turnId)。
