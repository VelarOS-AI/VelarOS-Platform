# ScriptAct 下一代交付报告

2026 年 10 月 3 日。本文记录本轮实际实现、公开合同和检查结果；设计依据见[设计方案](scriptact-next-generation-design.md)，独立模型对照的原始范围与限制见[实现与证据](scriptact-next-generation-implementation.md)。验收顺序为任务完成率、端到端时间、完整费用。

## 已交付提交

| 提交 | 实际范围 |
| --- | --- |
| `ed02541d` | Model 保留真实终态用量，校准请求与缓存前缀的容量估算；取消、断流和未取得用量分别记录 |
| `61273688` | Context 逐项核查报告、当前适用性、可选成功检查复用和原任务归属 |
| `212ed4cc` | 评测的环境准备、修复验证、版本对照、证据索引和全部原尝试计量 |
| `44691236` | Responses 流清理与解析诊断，保留原供应商结果和传输故障边界 |
| `09adc2e8` | ScriptAct 当前工作集、全文需求分配、失败回执召回、批量合同、领域快照、程序目录、核查投影及真实任务闭环 |
| `b76fc7ef` | 协议修复分支沿用普通请求校准；五模式回归和 Agent 全量 53 项通过 |
| `e471f82a` | Harbor 当前本地 egress helper 协议清理，集中使用当前协议 |
| `35316b1b` | 移除历史 checkpoint、嵌套正文引用和工作区绑定迁移；统一当前会话初始化、Harbor 调用端和合同测试；按仓库规范完成格式与结构清理 |

最终跑分的代码提交为 `35316b1bbc47eaa0ba63e2c61b06bf332c441fca`。本轮八项代码提交覆盖累积实现及最终清理；相对本轮开始时的 `a7a09084`，253 个文件变化，新增 18222 行、删除 1629 行，包含源码、生成合同、模板、测试和所属说明。文档与模型结果在同一交付报告中收尾。

## P0 / P1 / P2 实现验收

| 阶段 | 已实现内容与责任 | 代码落点 | 可验收行为 |
| --- | --- | --- | --- |
| P0 真实任务闭环 | 宿主提供任务事实与公开条件；Runtime 装配 Project，Shell 经现有能力端口挂载；领域完成回调核查当前实物 | `act/runtime/impl/RuntimeBootstrap.ts`、`contract/requires.ts`、`ContextCompletionPort.verify` | 真实文件编辑；Node 测试失败的退出码与日志进入下一实际请求；修复后相同命令通过；产物或保护范围核查失败继续原任务 |
| P0 按任务核查交付 | 领域拥有当前产物、规则与保护范围；Runtime 保留原报告和完成发布身份 | `ContextViewSession`、`ContextMemory`、`SessionGoal` | 完成前核查当前产物，失败反馈可继续修复；目标在检查期间变化时不提前完成；需要正文的任务按实际已接受请求核查 |
| P1 当前工作集 | Runtime 在软预算内优先保留约束、失败、未知效果、必需缺口和有序身份；长详情归档后可精确读取 | `utils/decision-state.ts`、`ProgramContext`、`ContextMemory` | 小状态保持原值；必要事实超额明确 `overBudget`；当前任务与授权水位限定归档召回；内部完整事实不因展示裁剪改变 |
| P1 失败诊断投影 | 领域给真实逐项报告；Runtime 在原额度内稳定选取 failed → unknown → passed | `utils/context-memory.ts`、`ContextMemory` | 保持原报告顺序与原 `index`，适用性按原位置绑定；长项不阻断后续诊断；省略有计数，整报告沿原引用补读 |
| P1 正文需求分配 | Script 按选中完整表示的实际编码申请共享预算 | `packages/script/src/utils/output-render.ts` | 无数字 `maxChars` 的显式 `full` 先计完整需求；字符串、对象、数组保持原值与身份；数值上限、全局配置及总上限继续有效，容量不足诚实降级 |
| P1 失败后继续使用原调用 | Runtime 将已有调用日志索引接到现有 `memory.read` | `ProgramContext`、`ContextMemory`、`types/memory.ts` | 绑定结果、执行、调用与会话读取原 outcome/effect/value/error；读取后重查授权；失败与未知不改成成功，不重派原操作 |
| P1 能力发现 | System 从正式 TS 合同提供真实导出索引、批量声明和按任务选择的常驻合同 | `SystemCatalog`、`ModulesOperations`、`utils/model-instructions.ts` | 真实导出名可直接 import；共同规则与依赖类型去重；完整目录分页可达；常驻合同与索引共同计入请求预算 |
| P1 请求与恢复计量 | Model/Agent 保留真实供应商用量，普通请求与协议修复使用同一校准规则；Trace 独立核对执行和核查活动 | `ActLoop`、Model 请求编译与流处理、`RuntimeTrace` | 被协议拒绝的响应不执行；可容纳的修复准入，真实超窗仍处理；图片与不透明部分不按文本比例缩放；取消与迟到费用归原身份 |
| P2 有条件复用 | 宿主和领域声明可靠范围，Runtime 分别管理观察、纯派生、检查与程序目录 | `RuntimeSession`、`ContextVerificationSession`、`ProgramsOperations` | 各机制按下表独立满足条件；失效、取消和重启保留真实采集或执行，不以目录、hash 或旧报告授予当前业务成功 |

模型负责业务判断和脚本组合；Runtime 负责预算、当前事实、身份与生命周期；领域和宿主负责真实输入、资源版本、测试及成功条件。任务合同使用现有可移植数据与完成端口，运行管理不交给模型手工维护。

## 公开合同与行为边界

本轮能力合同统一使用数组 `exports`：

```ts
modules.describe({ module: 'velaros:project', exports: ['read', 'edit'] })

// 常驻合同也是同一选择方式；省略 exports 则提供完整模块合同。
const runtimeOptions = {
  residentModules: [{ module: 'velaros:project', exports: ['read', 'edit'] }],
}
```

`SystemModuleDescribeInput` 和 `residentModules` 都按当前合同读取 `exports`，调用方须更新单导出字段与字符串常驻项；未保留过渡解析。所选导出默认返回声明，示例须显式请求 `template: true`。声明、效果、发现卡和模板由所属 TS 操作接口生成，生成基线与公共面检查同步更新。

`full` 是展示申请：只有未配置整体上限且块上限为 `undefined` 时，按完整选中编码申请容量。数字上限含零、`configure` 含零、reference、summary、auto 与部分选择保持各自规则；请求仍受宿主共享份额和 200000 字符总上限约束。原值、内容指纹、归档和源权限保持独立。

持久正文采用标准记录引用与当前 `objectReferencesVersion: 1`。Context 的完整状态、增量元数据、调用索引与调用正文共用当前初始元数据；Runtime 的工作区绑定、程序状态和 Search 首次占位也使用当前格式。已有未确认状态拒绝历史读取与对象回收。历史边界依据当前任务与授权重置；旧 checkpoint、嵌套引用和 workspace.json 的自动迁移路径均已清理。对应验收承诺由“迁移旧检查点一次”调整为“读取当前任务与授权边界”，损坏或未确认的数据保留明确诊断与回收保护。

普通维护任务的完成条件是实际问题、相关检查、保护范围与约定交付；正文条件由任务显式选择。`task-loop.test.mjs` 的正文用例检查真实 `runtime.trace` 中已接受请求的用户消息和宿主当前文件，引用与归档存在不能替代正文。该唯一公开文本夹具证明接线可用，不构成任意内容表达的通用证明器。

## 复用机制的实际条件

| 机制 | 生效条件 | 不能据此推定的内容 |
| --- | --- | --- |
| `observation.reuse.probe` | 宿主预登记并完整覆盖观察依赖；scope、任务、授权重置、模块实例相同；provider 生命周期与可识别 ABA 的 token 可靠；前后代次稳定且采集完整 | 年龄或内容 hash 不能证明期间无变化；unknown、超时、失败、变化或重启继续实际采集 |
| `observe({snapshot:{provider,plan,input}})` | 固定领域纯计划；授权 Kernel 前后完整捕获；完整值相同才复用纯派生，版本字段变化重新派生 | IO 每轮仍发生；源内容相同不证明历史未变，不是编辑凭据；完整捕获不保证材料适合模型窗口 |
| `checks.check(spec, execute)` | 核查器身份/版本和精确 scope；probe 原子覆盖全部产物、授权与可靠代次；只有完整通过且前后指纹一致才建立证明 | 旧通过报告不等于当前适用；不完整、失败、取消及 unknown 不复用，探测与真实检查成本都计入 |
| `programs.publish/list/describe` | 发布检查语法与实际 import，按名称 revision CAS 归档不可变 source/modules；查询核对当前授权、绑定与任务重置 | 发布不执行、不证明效果；每次 `execute({sourceRef,input,blobs})` 仍真实执行，目录与说明不授予权限 |

## 已完成检查

以下结果来自实际源码检查或 fresh 构建后的所属测试；定向集合相互重叠，不相加为全仓测试总数。原失败日志保留，修复后的结果单列。

| 检查 | 结果 | 记录或验收入口 |
| --- | --- | --- |
| Model 全模块 | 182 通过；流诊断定向 11 通过 | `model-tests.log`、`model-style-tests.log` |
| Agent | 53 通过；修复校准五模式通过，修复前 fits 反例保留 | `agent-final-tests.log`、`repair-calibration-before-b.log`、`repair-calibration-after-b.log` |
| Script | 165 通过；合同整理定向 26 通过 | `script-tests.log`、`script-cleanup-tests.log`；INV-35/44 |
| Context | Node 78 通过、4 跳过；Bun 21 通过；最终运行 exit 0 | `context-final-closed.log`、本轮 Node 终态记录；INV-16 |
| Runtime / System / Search / Agents | 696 通过，0 失败、0 取消 | `runtime-final-closed.log`；Search 新会话占位和共享空间合同回归包含在内 |
| 导出与发现合同 | 49 通过 | `exports-cleanup-tests.log` |
| 真实失败回执召回 | 7 通过 | `style-failed-call-recall-fixed-b.log`；Runtime INV-70 |
| 核查/输出定向 | 10 通过；独立失败投影 6 通过、编码边界 5 通过 | `style-context-memory-fixed-b.log`、`verification-projection-after-b.log`、`output-context-boundary-after-b.log` |
| 历史与回收保护 | 16 通过 | foundation-context / context-index 定向：取消、边界、回收、重开与未确认格式保护 |
| 真实任务闭环 | 3 通过，原 session 37899 exit 0 | `task-loop.test.mjs`；真实 Shell 失败→编辑→重测、完成拒绝继续、任务可选正文条件 |
| Project | 24 通过 | `project-delivery-tests-final.log`，此前模板/声明失败原记录保留 |
| Harbor | 完整 53 项中 52 项通过，历史保留用例按真实租约和不可变历史更新后定向 1/1 通过；另有已完成的 371 项离线环境检查 | `harbor-final-closed.log`、`harbor-retention-final-b.log`；原错误断言保留 |
| 构建与类型 | 8 包全构建完成；当前清理后按依赖拓扑增量构建通过，8 包 typecheck 完成 | `final-build-closed.log`、`gates-final-closed-after.log` |
| 所属合同门禁 | module ownership、生成 Script 面、Act 目录、33 段 README 示例通过 | `ownership-final-check.log`、`script-contract-check.log`、`act-catalog-check.log`、`contract-final-check.log` |
| 最终统一门禁 | lint、代码风格 37 项、module ownership、错误构造、Prettier、8 包 typecheck 全部通过 | `gates-final-closed-after.log`；exit 0 |

检查日志根目录：`.velaros-workspace/bench/scriptact-product-landing-20261003-80b64af8-6bdd-4cde-8265-e3f48e9d61ee`。首次完整回归的 28 项失败与 3 项取消、构建和测试并行导致的 dist 缺失、格式和 import 排序失败均保留原记录。最终按依赖顺序构建，消费者测试不并行重建 dist；本轮修复后的完整 Runtime 696 项与统一门禁为上述终态结果。

## 整题跑分与结论

### E8 原冻结对照：24 次原尝试

六项真实历史维护任务，两组各重复两次，共 24 次，全部计入分母。任务、源码、工具和判据在请求前冻结；测试、保护文件与完成状态由相同原工具复核。两组沿用 E7 冻结源码，产品差量为显式全文预算修正，共同接入现有 Shell。此对照评估该冻结差量，最终提交版另行回归。

| 指标 | 基线 | 候选 |
| --- | ---: | ---: |
| 原尝试 / 质量通过 | 12 / 12 | 12 / 12 |
| 质量失败 / 未知 | 0 / 0 | 0 / 0 |
| 整题完成时间总和 | 3130.294071 秒 | 2484.584083 秒 |
| 整个宿主进程时间总和 | 3244.071854 秒 | 2524.851651 秒 |
| 实际模型请求 | 187 | 139 |
| 已接受响应 | 180 | 135 |
| 实际运行公开测试的尝试 | 12 / 12 | 12 / 12 |
| 精确测试入口调用（exit 0 / 非 0） | 20（13 / 7） | 20（13 / 7） |
| 存在非 0 后同一测试通过链的尝试 | 5 | 5 |
| Shell.run 总调用 | 43 | 38 |
| 完整参考费用未知的尝试 | 6 | 4 |
| 已知部分参考费用 | $14.4373352 | $11.4815504 |
| 整组完整参考费用 / 实际账单 | null / unknown | null / unknown |

候选 / 基线完成时间比为 `0.793722`，本套件总时间减少 **20.63%**，质量通过率相同。这个结果来自六项历史维护任务，覆盖范围有限；本地主仓库收尾检查与部分原尝试运行时间重叠，保留运行环境干扰这一限制。费用缺口仍在，已知部分不能作为完整费用收益。

冻结报告中的 12 对整题时间比中位数为 `0.715611519`（中位下降 28.44%），范围为 `0.2912–2.0633`；存在耗时退化的尝试。宿主进程时间与任务完成时间各自报告，环境准备、关闭和子进程尾部不会混作模型时间。

实际模型测试活动按原保存调用日志计数，非零退出包含启动或环境问题，不能全部解释为功能缺陷复现。公开测试已真实运行；本地 task-loop 的三个集成用例另外逐项证明故障诊断、实际编辑、同一测试再通过及完成拒绝后继续修复。活动计数报告为 `LAND/e8-model-test-counts.json`，SHA256 `4501345ec9a9b5837adc31c95586ea38026305938298ea806c9136cfa00879f4`。

保存的 journal 进一步核实：两组各有 5/12 次尝试出现“精确声明测试非 0 → 实际 Project.edit changed 且涉及声明产物 → 同一命令与 cwd 再次 exit 0”，冲突调用为零。这证实真实反馈修复活动；仍不把所有非零退出视为功能断言失败，也不据此归因全部时间收益。报告为 `LAND/e8-model-test-edit-chain.json`，SHA256 `09633a4d3c25102281419fe312b4153eb8e564a220cb1006fb1da2a794d8b9d9`。

原报告：`.velaros-workspace/bench/scriptact-workflow-20261002-e8-a-7f7f6b5d/independent/comparison-final-original24-c.json`；SHA256：`3d82246a3645e31e7733802d1704213d72956bb1044c99fdcff2ba59c5e2c9fb`。原 runner 与一次冻结比较均 exit 0，24 次模型原尝试全部终态。

### 最终提交版本：六项开发回归

代码提交 `35316b1bbc47eaa0ba63e2c61b06bf332c441fca` 的 1980 份已提交源文件和 4165 份构建产物封存后，沿用上述六项任务、相同原测试、模型、限制、环境和费用口径，各执行一次，共六次原尝试，无外层重试。保留任务属于开发回归；不与原对照混合推导整体性能提升。

源码清单 SHA256：`b332b0a245950a03ff1e5a2e296d0204ef56049ac8a8d3bea8e6d4a141389964`；正式 manifest SHA256：`9ac37752a729dead2b16b6811927ff57df71e18f2797495b831df6e191a35bd2`。唯一实际启动预检 exit 0，模型与 oracle 调用为零。root 于 2026-10-02 17:32:44 UTC 唯一启动原六项模型批次。

六次原尝试已全部正常终态，原任务质量与业务核查均 **6/6**，失败为 0、未知为 0。唯一原批次进程 exit 0；完整时间、费用和冻结复核报告列于本节终态记录。

| 最终版本指标 | 全部六次原尝试 |
| --- | ---: |
| 质量通过 / 失败 / 未知 | 6 / 0 / 0 |
| 当前文件与原 native 业务核查 | 6 / 6 |
| 整题完成时间总和 | 1278.776301 秒 |
| 宿主进程时间总和 | 1299.511404 秒 |
| 实际模型请求 / 已接受响应 | 77 / 73 |
| 完整参考费已知 / 未知的尝试 | 2 / 4 |
| 已知部分参考费用 | $5.8035504 |
| 整组完整参考费用 / 实际账单 | null / unknown |

唯一冻结复核报告为 `.velaros-workspace/bench/scriptact-final-regression-c-20261003/independent/regression-final-original6.json`，SHA256 `c9db8679dc8308e9e16f1bcecc956f0e04c0f2cbc15e89a1d12b5732f55c5810`；原运行与原比较均 exit 0，所属模型、Runtime 和 native 子流程已经终态。

冻结工具既有机制触发聚合为零，本批证据证明当前版本能完成这六项维护任务，不能证明各复用机制或预算修正的因果节省。观察、快照、检查与程序机制的可靠性来自对应实现回归，净收益尚未在该任务组实测；完成后的本轮据此收尾。

本轮实现、规范清理、局部与完整回归、原 24 次对照和最终六题回归均已交付。代码以八项独立本地提交落在主仓库，报告与累积文档同轮提交。本轮目标按用户指定范围结束。

公开本地 Runtime / SDK 使用 stub，只证明真实产品主链和实际请求材料，不计为外部模型成绩。观察或检查复用、命名程序、失败投影及全文申请的收益仅在真实触发后按整题判断；字符、调用与缓存命中用于解释原因。
