# `@velaros-ai/agent-lab` 按仓库标准改造方案

> 对象：`packages/agent-lab`（0.1.4，evaluation 域，host 无关的评测基础设施 + `velaros-agent-lab` 命令），HEAD `606fba59`（数据采于 `7c39d5c9`；其后本范围内只有 core `utils/RealPath.ts` 的写法微调 `0ac2b5f1`，结论不变），本包工作区干净。
> 标准同其它方案；zod 的处理照 agent 方案 3.5 的裁决（类型手写 + `satisfies z.ZodType<…>`）。本包自己的门 `check:agent-lab-package`（`scripts/check-architecture.mjs`：钉死 10 个入口、`src/cli.ts`、`dist/cli.js`、零 `@velaros-ai/*` 依赖、六个「纯测量目录」不许碰 `node:` 与网络）挂在 `check:gates`；arch-guard 把本包列为 `portableLibraryPrefixes`（不套要求 core helper 的写法规则）。
> 基线：`bun test test` 44 pass / 0 fail（11 个文件）。缺陷复现脚本在草稿区 `plan-small/probe-lab/`。

## 0. 结论先行

- **规模**：`src/` 44 个源文件 6,856 行，10 个入口（根 + 9 个子路径，根是全部子路径的通配并集），子路径共导出 219 个符号。
- **唯一消费方是 Desktop 的开发工具**：`src/devtools/agent-lab/` 26 个文件、3 个测试、1 个检查脚本，共用了 65 个符号（`./protocol` 24、`./workload` 24、`./runner` 5、`./archive` 5、`./drivers` 3、`./detect` 2、`./report` 2）。**根入口、`./statistics`、`./certification` 零消费方**（后两者只被本包 CLI 用）。Platform 仓内与 Workbench、Termel 零 import。
- **主要问题**：模块按「目录 = 入口」组织，不是按合同；`protocol` 的类型手写、schema 另写，`parse(...)` 的结果用 `as JourneySpec` 强转，两边没有编译期对齐；`workload` 的 20 个类型又全从 zod 推导（types 只放类型的规矩做不到）；同一个枚举写两三遍；4 个类没有接口、3 个类出包；CLI 在 `src` 里带副作用并用动态 `import()` 加载宿主运行时；44 处英文报错与校验说明、探测器描述与发现摘要全英文；包内重复实现（规范化 JSON 3 份、HTML 转义 3 份、原子写 2 份）；「host 无关」的核心里写着 VelarOS 的工具名（`tooling:map`、`interaction:ask_user`）和 Desktop 专用的 Velar Hooks 驱动。
- **真 bug（均已复现或逐行核对）**：归档里的 harness 版本永远是 `0.1.0`；段预算与整程账本口径冲突，第二段会被整程时间误判超预算；`runJob` 一个试验失败就返回，其余试验在后台接着跑；Velar Hooks 客户端对 4xx 也重试（缺省 13 次、约 30 秒），POST 命令还会被重发；它的缺省凭据文件仍在 `os.tmpdir()`，Desktop 早已为防符号链接攻击把文件挪到 userData（§5）。
- **目标**：9 件整件能力（线格式解析、旅程运行、探测器/验证器注册、归档、报告、统计、认证、真实任务工作负载、命令行）；注入面收宿主执行体驱动、验证器、探测器与 CLI 的运行时加载器；可移植数据一个文件；入口 `.`、`./contracts`；可执行文件移到包根 `bin/`，动态 `import()` 留在 bin 里。
- **要拍板**：Velar Hooks 驱动迁回 Desktop；预算口径；是否允许依赖 core；探测器与报告文字改中文（§7）。

## 1. 现状

### 1.1 目录、入口与消费方

| 目录（= 入口） | 文件 / 行 | 内容 | Desktop 用了的 |
| --- | --- | --- | --- |
| `protocol/` | 3 / 977 | 旅程、试验、观测、归档 v3 的类型（手写）、zod schema、缺省值 | 24：`JourneySpec` 等 21 个类型、`parseJourneySpec`、`parseJobSpec`、`ObservationFaces` |
| `workload/` | 8 / 1,284 | 真实任务记录与案例（zod 推导类型）、审计、覆盖、自适应战役、输入效率、报告 | 24：`RealTaskCase` 等类型、`parseRealTaskRecord/Case`、`RealTaskAcceptanceContractSchema`（值，拿去 `.parse`）、`auditRealTask`、`promoteRealTaskCase`、战役 5 个函数、`classifyRunArchiveOutcome`、`summarizeRealTaskCoverage` |
| `runner/` | 6 / 891 | `runJourney`、`runJob`、`createMatrixJob`、`BudgetLedger`、摘要、`VerifierRegistry` | 5：`runJourney`、`runJob`、`createMatrixJob`、`VerifierRegistry`（`new`）、`AgentLabRuntime` |
| `detect/` | 4 / 807 | 13 个内置探测器、注册表、观测归一、看门狗 | 2：`createBuiltinDetectors`、`DetectorRegistry`（`new`） |
| `drivers/` | 3 / 959 | 轮询驱动、Velar Hooks 客户端与驱动 | 3：`createVelarHooksDriver`、`VelarHooksClient`（4 个文件引用，3 处 `new`）、一个类型 |
| `archive/` | 4 / 436 | 原子写 v3 归档、历史归档视图、目录发现、真实任务 bundle | 5 个读写函数 |
| `report/` | 3 / 474 | 报告模型与自包含 HTML、历史归档 HTML | 2 |
| `statistics/`、`certification/` | 2 / 715 | 配对 bootstrap、Wilson 区间、可比性；认证策略与判定 | 0 |
| `cli.ts` | 271 | 6 条命令；`main().catch(…)` 副作用；`import(runtime.mjs)` | — |

### 1.2 按标准要处理的点

- **类**：`VerifierRegistry`、`DetectorRegistry`、`VelarHooksClient`、`BudgetLedger` 都没有接口，前三个直接出包被 `new`。
- **类型与 schema**：`protocol/Types.ts` 手写类型 + `Schemas.ts` 另写 schema，`parseJourneySpec` 用 `as JourneySpec` 强转（两边对不上也编译得过）；`workload/Types.ts` 反过来 20 个类型全是 `z.infer`（类型依赖值）。`ObservationFace` 七个值写了三遍（类型联合、`ObservationFaces` 数组、schema 的 `z.enum` 两处）。
- **模块级状态**：无可变状态；`TerminalFinishReasons`、`InteractiveToolNames` 是规则数据（留在 utils）。
- **散落数字**：轮询 2,500 ms、稳定 2 次、缺省墙钟 240,000 ms、客户端重试 12 次与间隔 2,500 ms、驱动取 200 条、bootstrap 10,000 次、标识符 ≤ 160、并发 ≤ 64、run id ≤ 200。
- **测试**：11 个测试文件 44 条 + 共用夹具 + 一份 55 行的历史归档等价快照（架构门钉了行数与表头）。

## 2. 目标布局

```text
bin/velaros-agent-lab.js   可执行文件：解析 --runtime、在这里做动态 import，把工厂交给 agentLabCli.run(argv, { loadRuntime })
src/
  contract/   provides.ts、requires.ts、constants.ts
  types/      agent-lab.ts（可移植：旅程/试验/观测/发现/验证/归档 v3/真实任务/案例/覆盖/战役/认证报告等全部线格式与结果数据）
              options.ts（带回调或实例的选项：运行选项、驱动策略、报告选项、比较选项）
              internal.ts（CLI 参数、配对、执行态等内部工作类型）
  impl/       AgentLabCli.ts、JourneyRunner.ts、BudgetLedger.ts、DetectorRegistry.ts、VerifierRegistry.ts、LabWire.ts、LabArchives.ts、
              LabReports.ts、LabStatistics.ts、LabCertification.ts、RealTaskWorkload.ts、AdaptiveCampaign.ts、PollingDriver.ts
              （Velar Hooks 驱动与客户端若留在本包，另加 VelarHooksDriver.ts、VelarHooksClient.ts，见 §7-1）
  utils/      measure/（纯测量：detectors、normalize、watchdog、statistics、certification、audit、campaign、coverage、input-efficiency、archive-outcome、report-model、archive-view）
              wire/（zod schema：journey、archive、workload、certification，逐个 satisfies 对齐手写类型）
              render/（三种 HTML 报告与共用的转义）
              canonical-json.ts、budget.ts、arguments.ts、tuning.ts
  exports/    index.ts（Node）、contracts.ts
```

「纯测量模块不许碰 `node:` 与网络」这条保留：本包架构门改成扫 `src/utils/measure/**`、`src/utils/render/**`、`src/utils/wire/**`（原来扫六个目录名）。

| 现有 | 去处 |
| --- | --- |
| `protocol/Types.ts` | `types/agent-lab.ts`；`Detector`、`Verifier`、`LabDriver`、`SettleRequest` 这类带函数的接口进 `contract/requires.ts` |
| `protocol/Schemas.ts` | `utils/wire/journey-schemas.ts`、`archive-schemas.ts`（`satisfies`，删 `as` 强转）；三个 `parse*` 经 `labWire` 出包 |
| `protocol/Defaults.ts` | `ObservationFaces`、`UnlimitedBudget`、`EmptyBudgetUsage` 进常量表；`createUnobservedObservation` 进 `utils/measure/normalize.ts` |
| `runner/RunJourney.ts`、`Job.ts` | `impl/JourneyRunner.ts`（`runJourney`、`runJob`、`createMatrixJob`）；打分、丢弃记录等纯函数进 utils |
| `runner/BudgetLedger.ts` | `impl/BudgetLedger.ts`（包内类，配类上方接口）；`resolveBudget` 与判超进 `utils/budget.ts`，轮询驱动共用这一份 |
| `runner/Digests.ts`、`detect/Builtins.ts` 的 `canonicalJson`、`statistics` 的 `stableString` | `utils/canonical-json.ts` 一份，键按码点排序 |
| `runner/VerifierRegistry.ts`、`detect/Catalog.ts` | `impl/VerifierRegistry.ts`、`impl/DetectorRegistry.ts`，各配类上方接口与工厂 |
| `detect/Builtins.ts`、`Normalize.ts`、`Watchdog.ts` | 探测逻辑进 `utils/measure/`；`createBuiltinDetectors(thresholds)` 作为工厂留在 `DetectorRegistry.ts` |
| `drivers/PollingDriver.ts` | `impl/PollingDriver.ts`（工厂 `createPollingDriver`，返回 `LabDriver`） |
| `drivers/VelarHooks*.ts` | 迁回 Desktop `src/devtools/agent-lab/`（建议，§7-1）；留下则进 `impl/`，改工厂与接口 |
| `archive/*` | `impl/LabArchives.ts`；原子写只留一份；历史归档视图的纯解析进 `utils/measure/archive-view.ts` |
| `report/*`、`workload/Report.ts` | `impl/LabReports.ts` + `utils/render/`（转义只留一份） |
| `statistics/`、`certification/` | `impl/LabStatistics.ts`、`impl/LabCertification.ts` + `utils/measure/` |
| `workload/Audit.ts`、`Case.ts`、`Coverage.ts`、`InputEfficiency.ts`、`ArchiveOutcome.ts` | `impl/RealTaskWorkload.ts` + `utils/measure/` |
| `workload/AdaptiveCampaign.ts` | `impl/AdaptiveCampaign.ts` + `utils/measure/campaign.ts` |
| `workload/Types.ts` | 类型手写进 `types/agent-lab.ts`；schema 进 `utils/wire/workload-schemas.ts`；枚举进常量表 |
| `cli.ts` | `impl/AgentLabCli.ts`（命令实现、文字）+ `bin/velaros-agent-lab.js`（进程包装与动态 import） |
| 10 个 `index.ts` | 删除 |

登记表：`portable: 'agent-lab.ts'`，`tuning: 'tuning.ts'`，`browserSafeEntries: ['contracts.ts']`；分层 `[AgentLabCli] → [JourneyRunner, LabArchives] → [BudgetLedger, DetectorRegistry, VerifierRegistry, PollingDriver, LabWire, LabReports, LabStatistics, LabCertification, RealTaskWorkload, AdaptiveCampaign]`；环境变量表视 §7-1 决定（Velar Hooks 的 `VELAR_HOOKS_URL/TOKEN` 不是 `VELAROS_` 前缀，门禁的变量表只认 `VELAROS_*`，登记不进去）。

## 3. 合同草案

**provides**（都是类上方接口，出包的是实例或工厂）

| 接口 | 出包的值 | 取代 |
| --- | --- | --- |
| `LabWireApi` | `labWire` | `parseJourneySpec`、`parseJobSpec`、`parseRunArchive`、`parseRealTaskRecord/Case/Assessment`、`parseCertificationPolicy/Subject`，新增 `parseAcceptanceContract`（取代 Desktop 直接用的 `RealTaskAcceptanceContractSchema.parse`） |
| `JourneyRunnerApi` | `journeyRunner` | `runJourney`、`runJob`、`createMatrixJob` |
| `DetectorRegistryApi` | 工厂 `createDetectorRegistry()`、`createBuiltinDetectors(thresholds?)` | `new DetectorRegistry()` |
| `VerifierRegistryApi` | 工厂 `createVerifierRegistry()` | `new VerifierRegistry()` |
| `LabArchivesApi` | `labArchives` | `writeRunArchive`、`readRunArchive`、`readRunArchiveView`、`discoverRunArchives`、`writeRealTaskBundle`、`readRealTaskRecord`、`writeRealTaskCase`、`readRealTaskCase` |
| `LabReportsApi` | `labReports` | `createRunReportModel`、`renderReportHtml`、`renderHistoricalReportHtml`、`renderRealTaskReportHtml` |
| `LabStatisticsApi`、`LabCertificationApi` | `labStatistics`、`labCertification` | 统计 5 个函数、`certifySubject` |
| `RealTaskWorkloadApi`、`AdaptiveCampaignApi` | `realTaskWorkload`、`adaptiveCampaign` | 审计、固化、覆盖、归档结局、输入效率；战役 5 个函数 |
| `AgentLabCliApi` | `agentLabCli` | `cli.ts` 的 6 条命令 |
| （驱动） | 工厂 `createPollingDriver(adapter, policy?): LabDriver` | 同名函数 |

**requires**：`LabDriver`（宿主执行体驱动：开会话、发段、等稳定、采观测、中止、关会话）、`PollingDriverAdapter`（只懂原生状态的轻适配器）、`Verifier`、`RegisteredDetector` 与 `Detector`、`AgentLabRuntime`（套件运行时：注册表、取旅程、取驱动）、`AgentLabRuntimeLoader`（bin 注入的动态加载器，取代 `src` 里的 `import()`）、`JobRuntime`。

**constants**：观测面/阶段/覆盖度、发现严重度、失败闭集（15 个）、丢弃原因（8 个）、稳定结局种类、真实任务的终态/断言种类（15 个）/覆盖各轴/模型要求等全部枚举（冻结数组，类型用 `typeof` 派生，schema 用它建 `z.enum`）；`RunArchiveSchemaId = 'agent-lab/run@3'`、`MeasurementBasis = 'unique-tool-call'`；`UnlimitedBudget`、`EmptyBudgetUsage`、`DefaultLoopThresholds`；`AgentLabLimits`（标识符 160、并发 64、run id 200）；`AgentLabPackageVersion`（验收用例核对等于 `package.json`，修 §5-1）。

可调参数 `AgentLabTuning`：轮询间隔、稳定轮数、缺省墙钟、bootstrap 次数（以及留在本包时的 Hooks 重试次数与间隔、取消息条数）。

**要删的导出**：10 个入口里的全部 zod schema 值（Desktop 只用了 `RealTaskAcceptanceContractSchema`，改 `labWire.parseAcceptanceContract`）、`canonicalJson`、`sha256Json`、`createHistoryEntry`、`appendHistory`（零消费方）、各类工作用的内部类型；三个类改工厂。入口从 10 个收成 `.`、`./contracts`，Desktop 30 个文件的 import 改写（机械），另外 5 处 `new` 改工厂（其中 3 处是 Hooks 客户端，若 §7-1 迁回 Desktop 就不用改）、3 处（含 1 个测试）`RealTaskAcceptanceContractSchema.parse` 改 `labWire.parseAcceptanceContract`。升 0.2.0。

## 4. 用户面与模型面文字

- **44 处英文报错与校验说明**：CLI 用法与参数（`Usage: velaros-agent-lab validate …`、`Missing required --job` 等）、协议校验（`Duplicate leg id`、`Replicate index cannot exceed ofK`）、战役状态机（`Invalid failure transition`、`Fixed failures require a fix reference`）、归档（`Unsafe run id`）、Hooks（6 条）。改中文，标识符与命令原样保留。
- **探测器描述与发现摘要**（13 个探测器，例如 `Streaming output remains open after settlement.`）写进归档与 HTML 报告，用户直接读；报告正文与标题已是中文，摘要仍英文，同一页中英混排。改中文不影响测量（看门狗按「探测器 id + 摘要」去重，前后同一份文字）。
- **会发给被测 agent 的一句**：轮询驱动按策略拒绝确认时的 `Evaluation policy rejected this operation`，是模型看得到的拒绝理由，改中文。
- CLI 帮助、`run`/`compare` 的 JSON 输出字段名不变。

## 5. 实现层缺陷

1. **归档里的 harness 版本永远是 `0.1.0`**（已复现）：`harnessIdentity` 用 `options.packageVersion ?? "0.1.0"`，本包 CLI 与 Desktop 调 `runJourney` 都不传。复跑可比性里的「harness 版本」字段因此全是错的。修法：缺省取常量表的 `AgentLabPackageVersion`。
2. **段预算与整程账本口径冲突**（已复现）：`BudgetLedger` 整程只建一个、墙钟从整程开始算、工具调用与 token 取整程累计，却拿去和「整程预算被段预算覆盖后」的值比。两段旅程、第二段 `wallClockMs: 8000`、每段各跑 5 秒：只看第二段不该超，实际第二段第一次采样就被判 `budget-exhausted`。同时轮询驱动把同一个 `wallClockMs` 当成本段截止时间，两边不一致。当前 Desktop 的旅程都是单段、段预算为 `null`，暂不受影响；多段旅程一给段预算就会误判。方向见 §7-2。
3. **`runJob` 失败即返回，其余试验在后台接着跑**（已复现）：某个试验的 `resolveDriver` 抛错，`Promise.all` 立刻拒绝，另外几个 worker 继续从队列里取试验、开会话、发提示词，调用方已经拿不到它们的归档。修法：每个试验的失败收成 drop 记录继续跑，或者失败时停止派发并等在飞的试验收尾。
4. **Hooks 客户端对 4xx 也重试，POST 命令还会重发**（4xx 已复现）：`status < 500` 时的 `throw` 被同一个 `try` 的 `catch` 吞掉，接着 `delay` 再试；缺省 12 次重试、间隔 2.5 秒，401 要 30 秒才失败。5xx 与网络错误重试会让「发送一段提示词」这类非幂等命令发两次。修法：4xx 立即失败；非幂等命令只在确定没到达服务端时重试。
5. **Hooks 客户端的缺省凭据文件位置过时且不安全**：缺省读 `os.tmpdir()/velaros-hooks-endpoint.json`。Desktop 在 b309dd1a1 把这份「含 token 的凭据文件」挪进了 userData，注释写明原因是共享 `/tmp` 里固定文件名是符号链接攻击的靶子。现在 agent-lab 不设环境变量时找不到 Desktop 的真实文件（重试 30 秒后失败）；在多用户 Linux 上，别人往 `/tmp` 放一份同名文件，就能让它把命令（含提示词）发到对方的地址。Desktop 的开发工具构造客户端时都没传 `endpointFile`。修法：随 §7-1 迁回 Desktop，与 `scripts/tools/velar-hooks.mjs` 共用同一套位置解析。
6. **类型与 schema 没有编译期对齐**：`parse* … as JourneySpec` 强转，schema 少一个字段、类型多一个字段都编译得过；枚举三处各写一份。改 `satisfies z.ZodType<T>` 并由常量表派生枚举。
7. **规范化 JSON 的键序依赖区域设置**：三份实现都用 `localeCompare` 排键，任务、探测器、策略三个摘要跨机器可能不一致（「不可比」误报）；`undefined` 被写成字面 `undefined`，与 JSON 语义不同。合成一份、按码点排序。
8. 自定义 `LoopThresholds` 只作用于探测器发现，不作用于看门狗中止（`runJourney` 调看门狗时不传阈值，始终用缺省值）；段内抛错时记录的段开始时间写成了当前时间；原子写失败时临时文件不清理。

## 6. 步骤、检查与共享文件

1. 先修 §5-1、§5-3、§5-4、§5-8（行为明确、不涉口径），各配测试。
2. 常量表与手写类型（先写 `types/agent-lab.ts` 与 schema 的 `satisfies`，让编译器找出现有漂移）；utils 搬家（算法不改）；类与实例；`bin/` 与 CLI 注入加载器。
3. 本包架构门改写：入口名单改成 `.`、`./contracts`，必需文件改新路径，纯测量扫描改指 `utils/measure|render|wire`，保留「不许依赖别的 VelarOS 产品包」；历史归档等价快照原样保留。
4. `spec/invariants.md`（建议：INV-1 结果只由独立验证决定，没有验证就是 unknown，不被总分掩盖；INV-2 一个试验失败不影响其它试验，全部记进 drop；INV-3 归档 v3 严格校验，历史归档只读；INV-4 真实任务报告不嵌入提示词、回答、绝对路径与产物正文；INV-5 工具调用按 `toolCallId` 去重计数；INV-6 纯测量代码不做 I/O（门禁）；INV-7 `./contracts` 不碰 Node（门禁））与验收；`MODULE.md`；README 与 CHANGELOG。
5. 登记，升 0.2.0；Desktop 迁移表（30 个文件）。

检查：`bun scripts/ownership/check-module-ownership.mjs --only agent-lab`、`bun run check:agent-lab-package`（改写后的架构门 + typecheck + 测试）、`bun run --cwd packages/agent-lab check:legacy`、`bun run check:code-style`、`bun run check:agent-arch`（evaluation 域归属）、`bun run check:package-catalog`、`bun run check:lockfile-consistency`。

共享文件：`scripts/ownership/governed-modules.mjs`、根 `tsconfig.json`（本包 `tsconfig.json` extends 它，paths 改指 `src/exports/*`）、`arch-guard.config.mjs`（若 §7-3 允许依赖 core，删掉本包的 `portableLibraryPrefixes`）、`docs/generated/package-catalog.json`（`docs/agent-lab/*.md` 没有写入口子路径，不用改）、`bun.lock`。

## 7. 需要拍板

1. **Velar Hooks 驱动与客户端迁回 Desktop**：它们说的是 Desktop 的 hooks 协议与凭据文件约定，只有 Desktop 在用；迁走之后 agent-lab 才真是 host 无关，§5-4、§5-5 也在 Desktop 一侧用它现成的位置解析修掉。代价：Desktop 多 2 个文件，本包删 `./drivers` 里除轮询驱动外的部分。建议迁。
2. **预算口径**（§5-2）：建议「整程预算按整程累计、段预算按本段计」，账本分整程与本段两本；会改变多段旅程的判定结果与策略摘要（`policyDigest` 语义），需要你确认。
3. **允许依赖 `@velaros-ai/core` 吗**：架构门现在禁止一切 `@velaros-ai/*` 依赖（写的理由是不依赖「产品包」，core 不是产品包）。允许 core 之后可以用 `AppError` + 错误码代替英文 `Error`、用 core 的原子写与守卫，arch-guard 的豁免也能撤掉；代价是第三方安装时多一个包。建议允许，只许 core。
4. **探测器描述、发现摘要与 CLI 文字改中文**（§4）：本包对外发布给第三方执行体认证用；按标准第 10 条应改中文。建议改。
