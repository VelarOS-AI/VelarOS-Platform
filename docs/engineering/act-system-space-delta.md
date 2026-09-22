# Act 系统空间实施差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

`velaros:system` 已接入正式 Runtime。模型使用一个包管理自己的上下文、源码、结果和能力；仍经现有 ScriptAct、Kernel、ContextStorage 和 ProviderRequestCompiler 执行。

## 完成范围

- 物理结构：九个自管理模块集中到 `packages/velaros/act/system/`，共用 contract、types、impl、utils、spec 和模板。会话执行机制留在 runtime，搜索和任务委派保有各自职责。
- 实际装配：SystemModules 与 SystemPackage 集中可信成员，ComposedRuntime 和 AdvancedSearch 共享身份判定。每个子任务具备自己的自管理能力，业务 modules/writes 范围分别检查；宿主 authorize 继续检查真实调用。
- 包执行：ScriptPackageCompiler 将宿主映射编译成 granted 声明和包投影；KernelScriptSession、CodeSurfaceSession、Node runner 和 QuickJS 子进程传递同一数据。命名导入、命名空间导入及附属脚本均可使用，底层调用身份保持原值。
- 模型使用：协议说明、系统模板、上下文召回卡片、生成操作清单统一展示 velaros:system。十四份 Act 模板进入发布产物，其中系统入口一份、成员九份。
- 发现与生命周期：包目录先做会话授权/空间筛选再分页；聚合包按成员返回真实合同；基础系统包随会话保留，任务能力绑定可以释放。

## 契约变化

System 的 provides/requires 收拢原九个模块 API 与窄宿主端口，新增 SystemModulesApi/SystemHost。宿主 `/act/system` 提供相同装配实例；原 `/act/context` 指向同一发布文件，便于既有消费者过渡。

Script 的 KernelScriptSessionOptions 增加 packages；CodeSurfaceSession.submit 和 CodeRunRequest 传递编译后的包投影。新增 ScriptPackageDefinition、ScriptPackageSurface 和 scriptPackageCompiler/ScriptPackageCompilerApi。通用 Script 引擎通过宿主映射识别成员；Velaros 负责提供系统成员定义和旧聚合兼容映射。

九个底层 moduleId 与 instanceId 保持不变，系统 schemaRevision 更新为 11。逐项与本轮开始时的源文件快照比较：除以下 modules 四个操作外，十七个操作的 input/output schema、effects 和有效 allowedModes 全部一致。

| 操作 | 实际变化及原因 |
| --- | --- |
| modules.list | 返回模型包卡片；增加 space 筛选，权限过滤先于分页；系统包只占一张卡片 |
| modules.search | 在相同授权包目录内检索，不先对全局模块分页 |
| modules.describe | 接受 `module:velaros:system` 与可选 export，返回对应成员的真实 binding、schema、声明和模板 |
| modules.release | 只允许释放当前可访问的任务能力绑定，系统基础包返回 SYSTEM_REQUIRED；释放不改变宿主授予的权限 |

包卡片以 specifier 标识导入名；业务卡片提供 binding，系统卡片通过 exports 描述成员。依赖旧列表中 binding 必填假设的脚本应显式编辑。旧导入仍使用同一处理器，旧源码、引用和回执保持不可变；这次没有自动改写或重放持久脚本。

上下文召回卡片增加 export 字段，例如 `{module:'velaros:system',export:'history',operation:'list'}`。普通脚本原语 output、参数/blobs、外层 observe/execute/done、租约曝光计数和图像链路沿用既有机制。

## 验收调整

- 新增十项真实 QuickJS/Kernel/存储集成验收，覆盖附属脚本与参数、目录/模板、观察只读、动态授权、跨会话引用、租约、分页、身份冲突、未授权成员、子任务状态及重启恢复。
- 九个系统成员模板经共享包编译器检查，仍逐项断言模板覆盖全部真实操作。
- 原历史遗漏目录测试改为断言规范包名和 history 成员；分页范围、原文保留及有界性断言保留。
- 搜索作用域验收按新卡片 specifier 检查业务能力泄漏，继续要求 test:world 不可见。
- 所有权门支持同一包内已登记单元的纯工具/数据依赖，仍禁止 utils 引入实现类；所有模块继续执行完整检查。

## 验证结果

- Script、Velaros 构建及严格类型检查通过。
- Act 整组回归 215 项全部通过，包含新增十项系统空间集成验收。
- Script、Provider、MCP：82 项通过；Context：25 项通过。
- 所有权、能力边界、脚本合同生成、Act 目录、平台代、Agent API 检查通过。
- Velaros 和 Script 的安全打包检查通过，模板和新编译器进入产物。
- 与本轮前快照比较，十七个既有操作合同和九个模块身份保持一致；git diff --check 通过。

验证使用受控模型驱动和本地传输。真实 Provider 的模型行为评估、旧源码的批量自动迁移及 npm 发布未在本轮执行。
