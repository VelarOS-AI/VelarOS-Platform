# Act 模型自管理系统

## 这是什么

`velaros:system` 提供 `modules`、`memory`、主会话的 `goal` 和按存储能力装配的 `store`。主模型维护自己的笔记、计划和工作意图；整理模型处理派生展示；Runtime 负责版本、权限、预算与发布。业务能力使用自己的包空间。

## 提供什么

- `GoalHost` 注入当前调用会话的版本化目标账本；`goal.get/update` 与宿主控制共享状态。

入口 `./act/system`。

装配实例：`systemModules`、`memoryModule`、`modulesModule`、`storeModule`。

接口：`SystemModulesApi`、`SystemHost`、`MemoryModuleApi`、`MemoryHost`、`LongTermMemoryHost`、`MemorySession`、`MemoryStore`、`ModulesModuleApi`、`ModulesHost`、`ContextMaintenanceHost`、`ContextCandidateValidator`、`StoreHost`、`StoreModuleApi`、`StoreSessionApi`、`GoalLedger`。

各成员操作每次调用的宿主上下文（由本单元的装配从宿主端口按调用会话建出）：`GoalOperationContext`、`ModulesOperationContext` 与 `ModuleCatalogPort`、`StoreOperationContext`、`SystemMemoryOperationContext` 与 `MemoryOrganizerPort`、`ContextMaterialsOperationContext` 与 `ContextMaterialsPort`。

数据合同：`MemoryQuery`、`MemoryPage`、`MemoryListItem`、`MemoryOrganizeIntent`、`MemoryOrganizeReceipt`、`MemoryRetention`、`ResultRetained`、`ResultReleased`、`WorkspaceEntry`、`WorkspaceUpdate`、`ScriptRetention`、`StoreGrant`、`StoreEntry`、`StoreFrame`、`SystemModuleQuery`、`SystemModulePage`、`SystemModuleCard`、`SystemModuleDescription`、`ContextMaterialsQuery`、`ContextMaterialsReadInput`、`ContextMaintenancePage`。

`modules` 提供 list/search/describe。`memory` 提供 list/read/update/plan/retain/release（update 改笔记，plan 改任务计划）；主线和获准业务子任务额外具有 organize。主线装配 `RuntimeOptions.memory(sessionId)` 后额外提供 recall/save/remove，复用 `velaros/memory` 的长期记忆存储。搜索使用同一记忆实现的本地合同。整理会话只有 `velaros:context-materials` 的 list/read，并通过 ScriptAct output 提交补丁。

操作清单与入口模式见 [Act 清单](../README.md)，系统示例见 [template.js](template.js)，记忆示例见 [memory-template.js](memory-template.js)。

模型统一用 `modules.describe({module, export?})` 读取声明与模板（operations 里另附由声明派生的 schema）。`template` 字段来自当前会话授权的实际模块；模板仅在显式读取并输出时进入上下文。通常先 `output(await modules.list())`，再查询对应包并 `output(api.template,{type:"code"})`；需要精确类型时输出 `api.declarations`。

`store` 提供 create/list/keys/get/set/remove/watch/publish/subscribe/events/ack/share/read；可写投影提供 list/keys/get/set/remove/watch/publish/subscribe/events/ack/share/read，只读投影提供 list/keys/get/watch/subscribe/events/ack/read。StoreGrant 固定空间 ID 和读写范围，StoreFrame 提供有界目录与变化。三份模板为 store-template.js、store-write-template.js、store-read-template.js，由 modules.describe 返回。

## 骨干链路

`impl/*Operations.ts` 的操作接口（带 `@AgentView` 的方法、入参与回执类型及其注释）是模型面的唯一来源：`bun run generate:script` 由它写出 `contract/surface.ts`（给模型的声明、派生的 schema、效果与允许的入口）；按授权与装配分几种投影的成员（memory 四种、store 三种）各登记自己拿得到的几份接口，实现是同一个类。

SystemModules → `impl/*Module.ts` 用 `capabilityModules` 把生成的模型面接到本会话端口 → Kernel 注册、结构校验、模式与权限检查 → 实现自己核对取值上限 → 持久回执。ScriptPackageCompiler 为发现、类型检查和执行生成相同的包投影。

整理请求返回 requestId/scheduled。下一请求边界的整理服务读取固定父快照，提出带源版本的展示补丁。提交时先做完整预检，错误反馈给同一支线修正；完成后再经父请求编译、取消检查与 CAS 发布；结果随下一帧自动反馈。

## 依赖什么

contract/requires.ts 注入现有会话、Kernel 和整理端口。任务原文与状态复用 ContextStorage，跨会话记忆复用宿主提供的 MemoryScopePort；ScriptAct、ProviderRequestCompiler 负责执行和窗口校验。

## 状态归谁

主模型的原始笔记、计划与用户输入保存在原存储中。派生笔记摘要绑定不可变原文引用，主模型更新后自动失效。宿主拥有权限、模型档位和生命周期。

## 生命周期

随 Runtime 装配，按真实 sessionId 解析状态。整理显式请求按逻辑任务隔离；同边界的请求合并意图并保留稳定身份。会话关闭归还执行权和预算。长期记忆端口在主会话打开时固定，由宿主定义作用域，不因任务切换或 Runtime 关闭而清空。召回结果按脚本输出进入现有租约和预算链；release 只释放任务材料驻留，remove 才删除长期原文。

## 失败语义

失败补丁不发布，下一帧携带失败原因和未解项。原文通过统一引用读取。明确要求保留的笔记和结果不能被整理移出或释放。整理只改变展示，不重放业务脚本。

## 不变量

共 20 条，未验证 0 条。见 spec/invariants.md。

## 非目标

业务能力及其世界效果由领域模块、宿主授权和 Kernel 管理。

## 结构

```text
system/
  contract/ 接口和常量；surface.ts 是生成的模型面
  types/ 数据
  impl/ 操作接口与实现、装配、发布实现
  utils/ 成员身份解析与装配端口核对
  spec/ 验收
  index.ts
  template.js
  <能力>-template.js
```

## 持久 store

唯一模型成员为 `velaros:system.store`，提供 create/list/keys/get/set/remove/watch/publish/subscribe/events/ack/share/read。StoreConfiguration 固定宿主边界、创建权限和 StoreGrant 列表；新会话通过 create 建立空间，已创建或获配的空间通过 list 发现；StoreEntry 返回实际范围，StoreFrame 按总预算提供目录页与多空间变化。只读投影保留 list/keys/get/watch/subscribe/events/ack/read，可写投影额外提供 set/remove/publish/share，创建投影再提供 create。三份模板均通过 modules.describe 返回。

JSON 对象保存在 ContextStorage.stores，生命周期独立于脚本、结果租约和 Runtime。list/keys/get/events/read 可在 observe 使用，其他操作只在 execute。版本写入、订阅确认与原 Kernel 依据检查共用真实回执。子任务通过 start.stores 获配父权限子集，续跑重新核验；搜索和整理不装配此成员。

当前任务使用的空间 ID 保存在 ContextTaskState.storeRefs，通过原 ContextStorage CAS 合并。create/get/keys/set/remove/watch 和共享委托自动登记；宿主 grants 与子任务获配空间自动进入活跃集合。每轮 runtime.stores.active 重新按实际权限物化 id/name/description，按预算显示并报告 omitted；完整活跃目录使用同一 store.list({active:true}) 分页读取。继续同一任务保留引用，task:new 重建，归档和授权撤回后的元数据不进入请求。

整理支线的 `runtime.modelTool.inputs` 直接展示受预算约束的父输入原文页。只有实际请求的响应被接纳后才确认展示范围；完整原文尚未覆盖时，输入摘要返回 `CONTEXT_INPUT_UNSEEN`，可分页读取后继续或保留原输入。
