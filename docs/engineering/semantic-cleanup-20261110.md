# 0.9.5 后的语义与职责清理覆盖

基线为 canonical main `70e93a2b` / `v0.7.6`，基础包与能力包 0.9.5。本轮在安全工作树独立开发；原 D 工作树、用户文件与索引保持原样。按真实故障边界分批，未改版本、依赖或模型操作面，也不重新装配三产品或重跑旧发行证明。

## 覆盖与保留

| 范围 | 本轮阅读链路 | 结论与保留理由 |
| --- | --- | --- |
| Runtime 装配 | RuntimeBootstrap、NodeRuntime、NodeRuntimeBinding、ComposedRuntime、SessionExecutionBinding、EffectScheduler、RuntimeDiagnostics；Node/npm 适配与会话绑定工具 | 保留显式依赖注入、借用/自有资源区别、CAS 会话绑定、原产品绑定迁移拒绝、写锁等真实处理器退出、诊断观察者隔离。路径与身份的重复校验服务不同公开入口，不机械合并。 |
| Runtime 程序目录 | ProgramContext.catalogAvailable → RuntimeSession 的 binding/import 校验；真实 SQLite 目录夹具 | 修复宽 catch 掩盖后端故障。保留授权与 reset 水位、绑定不变的检查复用及变动后的重新检查。未重开 observe 的小型动态区与局部历史方案。 |
| Runtime 子任务 | ComposedRuntime.openChild → ModelToolRuntime 活动登记/释放、BudgetedModelDriver 结算、ChildTaskMaterials 所有权 | 修复二次清理错覆盖原启动错。保留取消广播、真实会话/模型先收束再删除材料与归还活动、聚合原错误身份和顺序。 |
| Execution | ShellCommandRunner 受理/启动/track/dispose → ShellProcessManager/ShellManagedProcess 的终态与真实 close | 修复 PTY 工厂重入关闭时的迟交 owner 漏检。保留有界 unknown、真实退出后重试、关闭准入以及严格前台另等真实管道排空。 |
| Runtime 宿主读取 | RuntimeSession.completedTask/taskMaterials/readTaskMaterial/trace 与既有 getGoal/listNotes 的 hostOperations；ComposedRuntime.trace/traceBranches 与 shutdown | 会话读取沿现有屏障，Runtime 冷 trace 由自己的 owner 排空，不新增第二套关闭状态；原授权和材料范围继续有效。 |

这是上述调用链的本轮审查，不把旧“26 模块基础通读”或本轮定向检查写作全仓语义无问题。

## 批次与差量

| 批次 | 实际问题与改动 | 合同影响 | 验证/提交 |
| --- | --- | --- | --- |
| R1：错误边界 | 子任务启动失败后的活动释放错误纳入已有 cleanup 汇总，原启动错误保持第一项；程序目录只隐藏明确的当前授权、挂载和 import 拒绝，存储、归档 JSON 和未知检查错误继续抛。 | 公开签名、模型操作和权限不变；恢复错误来源，README 与 INV-81 明确目录故障规则。 | 5 个定向场景通过；独立提交。 |
| E1：执行关闭 | dispose 先排空已受理启动，再取当前实际持有的 owner；重入关闭不能以空 owner 快照兑现成功。 | 落实既有 INV-20；无签名变化、无新的 OS 或执行回落。 | 新 PTY 单例与两条相邻用例通过；独立提交。 |
| R2：宿主读取 | 将四个遗漏入口纳入现有关闭准入与 hostOperations 屏障；Runtime 在释放存储前另排空自己受理的冷 trace 查询。 | 落实关闭承诺；数据和授权范围不变。 | 6 个入口的 barrier、关闭拒绝与原返回通过；独立提交。 |

R1 的相邻目录用例还暴露了版本迭代后的夹具冲突：旧用例用更换模块清单/实例后重开同一历史来模拟撤权或操作合同变化，而当前会话绑定合同要求这种恢复先报 `CONFLICT`。权限变化改由真实 `moduleAccess` 注入，操作变更改由正式目录校验端口和独立 Kernel 检查器验证；另保留跨绑定重开的拒绝断言，不放松持久绑定、不给产品增加迁移回落。

重验证共用 `D:/Projects/VelarOS-Desktop/scratchpad/with-heavy-validation-lock.mjs`，保持 2048 MiB 顺序类型预算；源码批次完成后统一格式、单次 Velaros 构建/类型检查及 module ownership，行为证明按批只跑新增故障和必要相邻分支。供应商、跨 OS、全量套件、旧 108 风格诊断及旧归档矩阵不在本轮范围。

已通过改动 lint、统一格式、单次 Velaros 构建/类型检查与 module ownership。新用例的配额和取消异常断言校准，以及旧目录夹具校准后，仅复核实际失败项；原绿项和构建/类型证据继续保留。日志位于本工作树 `.velaros-workspace/semantic-cleanup-20261110/`。

下一组范围：AgentSupervisor 的交互准入、事件/结果投递，与 Context 控制读取和取消的 owner 交接；这是后续审查范围，不宣称这些链路已有故障。
