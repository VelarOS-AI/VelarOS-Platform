# @velaros-ai/agent-lab 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/` 里各个类上方的接口（`contract/provides.ts` 登记它们），注入面在 `contract/requires.ts`，常量表在 `contract/constants.ts`。
> 门禁：`bun run check:module-ownership`、`bun run check:agent-lab-package`。

## 这是什么

可复现的**连续旅程**评测：让一个执行体在同一个会话里把一条旅程的每一段依次走完，把过程与判定落成一份不可变归档，
再从归档出报告、算统计、做认证；另有一条真实工作负载的线，审计产品里一次普通运行、把它固化成复跑用例。

它刻意**不认宿主**：不认识任何具体执行体，也不认识任何宿主的 hooks 协议、凭据文件、数据目录或工具名。
「怎么驱动一个执行体」「什么算通过」「探测器是哪几个」「工具目录页叫什么名字」全部从 `contract/requires.ts` 的注入面塞进来。
本包自己只带一个通用的轮询驱动；认协议的驱动（例如 Desktop 的 Velar Hooks）由那个宿主实现，`labDrivers.register` 接进来。

结果只由独立验证决定：没有验证器判过的事一律是未知，不被总分掩盖；没看到的观测面一律显示未知，不按 0 处理。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：每件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `labWire` | `LabWireApi` | 九种线格式的严格校验入口（旅程、job、归档、真实任务记录/评估/用例、验收合同、认证策略/对象） |
| `journeyRunner` | `JourneyRunnerApi` | 跑一条旅程、跑一个 job 的全部试验、把矩阵展开成一批试验 |
| `labDrivers` | `LabDriversApi` | 造内置轮询驱动；登记与查找宿主自带的驱动 |
| `labArchives` | `LabArchivesApi` | v3 归档原子写、四代归档只读、真实任务三件套与复跑用例落盘 |
| `labReports` | `LabReportsApi` | 报告模型与三份自包含 HTML（运行、历史归档、真实任务） |
| `labStatistics` | `LabStatisticsApi` | Wilson 区间、可靠性、失败分布、可比性核对、成对比较 |
| `labCertification` | `LabCertificationApi` | 按策略认证一个执行体或 mod，出一份带自摘要的报告 |
| `realTaskWorkload` | `RealTaskWorkloadApi` | 真实任务审计、固化成复跑用例、加权覆盖、归档结局折算、输入效率 |
| `adaptiveCampaign` | `AdaptiveCampaignApi` | 选下一批用例、失败账状态机、证明任务的记与校准 |
| `agentLabCli` | `AgentLabCliApi` | `velaros-agent-lab` 的六条命令；只返回退出码与两段文字 |
| `createDetectorRegistry` | 工厂 → `DetectorRegistryApi` | 开一份探测器注册处（含十三个内置探测器与看门狗） |
| `createVerifierRegistry` | 工厂 → `VerifierRegistryApi` | 开一份验证器注册处 |
| `RunArchiveSchemaId` | 契约常量 | 运行归档（v3）的 schema 身份 |
| `MeasurementBasis` | 契约常量 | 测量口径 `unique-tool-call` |
| `RealTaskRecordSchemaId`、`RealTaskAssessmentSchemaId`、`RealTaskCaseSchemaId`、`CertificationReportSchemaId` | 契约常量 | 四种载荷的 schema 身份 |
| `AgentLabPackageVersion` | 契约常量 | 本包版本；归档的 harness 版本缺省取它 |
| `ObservationPhases`、`ObservationCoverages`、`ObservationFaces` | 契约常量 | 观测的阶段、覆盖度与七个面 |
| `TranscriptRoles`、`TranscriptKinds`、`ArtifactProvenances` | 契约常量 | 转写块的角色与种类、产物来源 |
| `FindingSeverities`、`FailureClasses`、`AttritionCauses`、`DetectorAbortClasses` | 契约常量 | 判词严重度、失败闭集、丢弃原因、中止类别 |
| `VerificationOutcomeKinds`、`SettleOutcomeKinds`、`ContinuableSettleOutcomeKinds`、`BudgetLimits` | 契约常量 | 验证结局、收敛结局、可继续的结局、预算五维 |
| `SettleSignals`、`VerifierIsolations`、`ConfirmationPolicies` | 契约常量 | 收敛信号、验证器隔离、审批策略 |
| `ArchiveShapes`、`VerdictLevels` | 契约常量 | 四代归档形状、报告判词分量 |
| `ComparisonDecisions`、`CertificationSubjectKinds`、`CertificationStatuses`、`CertificationCheckStatuses` | 契约常量 | 比较结论与认证的三张表 |
| `RealTaskTerminalStatuses`、`RealTaskAssertionOutcomes`、`RealTaskAssertionKinds`、`RealTaskSpanCategories` | 契约常量 | 真实任务的终态、断言结论与取证方式、跨度类别 |
| `RealTaskArtifactProvenances`、`RealTaskSources`、`RealTaskCaseSources` | 契约常量 | 真实任务产物来源与触发来源 |
| `RealTaskPrivacyClassifications`、`RealTaskCasePrivacyClassifications`、`RealTaskCaseOriginKinds`、`RealTaskFeedbackVerdicts` | 契约常量 | 内容策略、用例来路与用户确认 |
| `RealTaskFindingClasses`、`RealTaskHealths`、`RealTaskVerdicts`、`RealTaskCoverageOutcomes` | 契约常量 | 真实任务的发现分类、健康度、综合判词与覆盖结局 |
| `RealTaskCoverageArchetypes`、`RealTaskCoverageDataShapes`、`RealTaskCoverageRisks`、`RealTaskCoverageLifecycles` | 契约常量 | 覆盖的四条轴 |
| `RealTaskCoveragePaths`、`RealTaskCoverageInteractions`、`RealTaskModelRequirements` | 契约常量 | 覆盖的另外三条轴 |
| `CampaignRootCauseClasses`、`CampaignFailureStates` | 契约常量 | 失败根因归类与状态机的状态 |
| `AgentLabLimits` | 契约常量 | 标识符长度、并发上限、run id 长度、用例权重上限 |
| `UnlimitedBudget`、`EmptyBudgetUsage`、`DefaultLoopThresholds` | 契约常量 | 不设限预算、空用量账、打转探测的缺省阈值 |

**注入面**，声明在 `contract/requires.ts`：`Detector`、`Verifier`、`RegisteredDetector`、`SettleRequest`、`LabDriver`、
`PollingDriverAdapter`、`LabDriverProvider`、`AgentLabRuntime`、`AgentLabRuntimeLoader`、`JobRuntime`，每一个都从根入口导出。
带行为的选项在 `types/options.ts`：`RunJourneyOptions`、`CertificationInput`、`AgentLabCliOptions`。

**数据面**是 `types/agent-lab.ts`（可移植）：旅程与试验、观测与判词、归档与视图、报告模型、统计结果、认证报告、
真实任务记录/评估/用例/覆盖、自适应战役的账，以及命令行结果，全部手写，schema 逐个 `satisfies` 对齐它们。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 进程（评测套件、CLI 壳） | 九件能力、两个注册处工厂、注入面与全部数据 |
| `./contracts` | 任何进程，含渲染进程与第三方工具链 | 常量表与可移植数据 |

装出来的命令是 `velaros-agent-lab`，可执行文件在包根 `bin/velaros-agent-lab.mjs`，它只是壳。

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 跑一条旅程 | `journeyRunner.runJourney(options)` → `utils/wire/journey.ts` 严格校验旅程 → 核对门探测器与验证器都注册过 → 驱动开会话、准备工作区 → 每段：`driver.send` → `driver.waitSettled`（采样时两本账各自判超预算、注册处给看门狗基线与中止裁决）→ `driver.collect` → `utils/journey.ts` 的 `verifyLeg` 逐条判据 → `scoreCriteria` 打分 → 落 `LegResult` 与丢弃记录 → 收尾合并用量、上下文与产物，出一份归档 |
| 跑一个 job | `journeyRunner.runJob(job, runtime)` → 按并发度派发 → 每个试验 `resolveDriver` + `runTrial` + `onArchive` → 任一失败即停止派发、等在飞的收尾、抛第一个错误 |
| 造驱动 | `labDrivers.createPolling(adapter, policy?)` → `impl/PollingDriver.ts`（预算、审批策略、稳定空闲、栅栏都在这里）；宿主驱动走 `labDrivers.register` → `labDrivers.create(id, parameters)` |
| 探测与看门狗 | `createDetectorRegistry()` → `registerBuiltins({ thresholds, catalogToolNames, interactiveToolNames })` → `utils/measure/detectors.ts` 造齐十三个 → `detect` 按阶段与观测面过滤；`watchdogBaseline` / `watchdogAbort` 走 `utils/measure/watchdog.ts`，用同一份阈值 |
| 写读归档 | `labArchives.writeRunArchive` → schema 校验 → `utils/archive-files.ts` 原子写；`discoverRunArchives` → 一个运行目录一份，优先 `report.json` 退回 `progress.json`；`readRunArchiveView` → `utils/measure/archive-view.ts` 四代形状 |
| 出报告 | `labReports.createRunReportModel(archive)` → `utils/measure/report-model.ts` → `renderRunReportHtml` / `renderHistoricalReportHtml` / `renderRealTaskReportHtml` → `utils/render/` 渲染并当场核对自包含 |
| 统计与认证 | `labStatistics.compareExecutors` → 配对 → 簇 bootstrap；`labCertification.certify(input)` → `utils/measure/certification.ts` 的五组检查 → 合成结论 → `utils/digests.ts` 给自摘要 |
| 真实任务 | `realTaskWorkload.audit(record)` → `utils/measure/workload.ts`（验收证据定结果、跨度定健康）；`promoteCase` 固化成复跑用例；`summarizeCoverage` 与 `classifyArchiveOutcome` 出加权覆盖 |
| 自适应战役 | `adaptiveCampaign.selectTasks(input)` → `utils/measure/campaign.ts` 打分选批；`recordFailure` / `transitionFailure` / `recordProof` / `reconcileProof` 推失败账的状态机 |
| 命令行 | `bin/velaros-agent-lab.mjs` 把 `process.argv` 与一个动态 import 的加载器交给 `agentLabCli.run(argv, options)` → `utils/arguments.ts` 拆参数 → 六条命令各自调上面的能力 → 回退出码与两段文字，由壳写出去 |

## 依赖什么

- 只依赖 `zod`，没有任何 `@velaros-ai/*` 依赖：本包要能被第三方独立安装、拿去认证自己的执行体。
- **不读任何环境变量**：地址、凭据、驱动、工具名单全部从注入面进来。
- 碰 Node 的只有归档读写、摘要与命令行那几条路；`utils/measure/`、`utils/render/`、`utils/wire/` 与 `./contracts` 一律不碰。

## 状态归谁

- 两个注册处（探测器、验证器）各自持有自己那套 Map 与探测设置，一套评测一份，由工厂新建，进程里可以有很多份。
- `labDrivers` 持有宿主驱动的登记表（进程级一份）；每个 `PollingDriver` 实例持有自己会话的原生栅栏。
- `BudgetLedger` 持有一段时间的用量；整程一本、每段一本，不共享。
- 其余出包的实例（`labWire`、`labArchives`、`labReports`、`labStatistics`、`labCertification`、`realTaskWorkload`、`adaptiveCampaign`、`journeyRunner`、`agentLabCli`）都没有可变状态。

## 生命周期

会话的生命周期归驱动：`openSession` 开、`closeSession` 关，`runJourney` 无论走到哪一步都在 `finally` 里关一次，关失败记成一条判词而不是丢掉归档。
注册处与账本随调用方存在；进程里的几个实例随进程存在，没有需要释放的东西。

## 失败语义

- **环境与基础设施的失败不算能力失败**：驱动报不出能力或身份、开会话或准备工作区失败、判据判不了，都落成 `drops`（丢弃），既不进分子也不进分母。
- **段内抛错**折成 `unavailable / harness-failure` 的收敛结局与一条 `warn` 判词，旅程当场停下，已经跑完的段照样进归档。
- **校验失败抛错**：线格式不合法、run id 不能当目录名、评估不属于这条记录、复跑用例缺提示词或缺验收门，都当场抛（中文，标识符与命令原样）。
- **命令行不抛错**：参数不对、文件读不出来、校验不过都折成 stderr 与退出码（0 正常 / 1 失败 / 2 判不了）。
- 外面判断失败看结构（`drops`、`settleOutcome.kind`、`status`、退出码），不看文字。

## 不变量

共 14 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 11 条、门禁 2 条、类型 1 条。未验证 0 条。

## 非目标

- **不认宿主**：不实现任何宿主协议的驱动，不读宿主的凭据文件、数据目录与环境变量；Velar Hooks 那一路属于 Desktop。
- **不管执行体怎么实现**：提示词怎么发、工具怎么跑、上下文怎么治理都由被测执行体自己定，本包只观测与判定。
- **不猜**：看不到的观测面、判不了的判据、缺失的历史字段一律是未知，不补缺省值、不按 0 处理、不并进最相近的那一类。
- **不做调度与存储服务**：归档就是磁盘上的文件，没有数据库、没有后台进程、没有远程上报。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记十二个类上方接口，requires.ts 是十个注入点，constants.ts 是全部枚举、身份与公开上限
  types/        只放类型：agent-lab.ts 可移植数据（线格式的单一来源）、options.ts 带回调的选项、internal.ts 包内工作类型
  impl/         一类一文件：命令行、旅程运行、归档、驱动装配与轮询驱动、线格式、报告、统计、认证、真实任务、战役、两个注册处、用量账本
  utils/        纯函数：measure/ 十份测量、render/ 四份渲染、wire/ 四份 schema，外加规范 JSON、摘要、预算、参数、归档文件与 tuning.ts 可调参数表
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
bin/            velaros-agent-lab.mjs：可执行壳，只把进程环境与一个动态 import 的加载器交给 agentLabCli
spec/           不变量登记、验收测试与共用假对象
test/           实现测试
```

**分层**（登记在 `governed-modules.mjs`，上层可以引下层与同层，下层不许引上层）：

1. `AgentLabCli.ts`
2. `JourneyRunner.ts`、`LabArchives.ts`
3. `LabDrivers.ts`、`LabWire.ts`、`LabReports.ts`、`LabStatistics.ts`、`LabCertification.ts`、`RealTaskWorkload.ts`、`AdaptiveCampaign.ts`、`DetectorRegistry.ts`、`VerifierRegistry.ts`、`BudgetLedger.ts`
4. `PollingDriver.ts`

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出，公开的在 `contract/provides.ts` 登记；类的公开成员只能是接口里的成员。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `AgentLabCli.ts` | `AgentLabCliApi`（provides 登记） | 六条命令；只返回退出码与两段文字，不碰 `process` |
| `JourneyRunner.ts` | `JourneyRunnerApi`（provides 登记） | 跑旅程、跑 job、展开矩阵试验 |
| `LabArchives.ts` | `LabArchivesApi`（provides 登记） | 归档与真实任务数据的读写，写一律原子且先校验 |
| `LabDrivers.ts` | `LabDriversApi`（provides 登记） | 造轮询驱动；登记与查找宿主驱动（S6 的注入口） |
| `PollingDriver.ts` | `LabDriver`（requires 声明） | 唯一内置驱动：预算、审批、稳定空闲、栅栏 |
| `LabWire.ts` | `LabWireApi`（provides 登记） | 九种线格式的严格校验入口 |
| `LabReports.ts` | `LabReportsApi`（provides 登记） | 报告模型与三份自包含 HTML |
| `LabStatistics.ts` | `LabStatisticsApi`（provides 登记） | 区间、可靠性、分布、可比性、成对比较 |
| `LabCertification.ts` | `LabCertificationApi`（provides 登记） | 按策略出认证报告，带自摘要 |
| `RealTaskWorkload.ts` | `RealTaskWorkloadApi`（provides 登记） | 真实任务审计、固化、覆盖、结局折算、输入效率 |
| `AdaptiveCampaign.ts` | `AdaptiveCampaignApi`（provides 登记） | 选批与失败账状态机 |
| `DetectorRegistry.ts` | `DetectorRegistryApi`（provides 登记） | 探测器注册、探测与看门狗，共用一份阈值与工具名单 |
| `VerifierRegistry.ts` | `VerifierRegistryApi`（provides 登记） | 验证器注册与查找 |
| `BudgetLedger.ts` | `BudgetLedgerApi`（包内，不出包） | 一段时间的用量账 |
