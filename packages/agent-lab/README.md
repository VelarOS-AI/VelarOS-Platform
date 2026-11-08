# @velaros-ai/agent-lab

可复现的 agent 评测：让被测执行体在同一个会话里依次走完一条旅程的每一段，落成不可变归档，再出报告、算统计、做认证；另一条线审计产品里一次普通运行留下的真实任务记录，值得长期复现的再固化成复跑用例。给评测套件、产品宿主与第三方执行体用，命令行是 `velaros-agent-lab`。

## 用法

```ts
import {
  createDetectorRegistry,
  createVerifierRegistry,
  journeyRunner,
  labArchives,
  labDrivers,
  labReports,
  type PollingDriverAdapter,
  type TrialSpec,
} from '@velaros-ai/agent-lab'

// 宿主提供：会开会话、发提示词、报原生执行态的适配器；旅程定义（JSON）与这次试验的身份
declare const adapter: PollingDriverAdapter
declare const journey: unknown
declare const trial: TrialSpec
declare function testsPass(workspaceRoot: string): Promise<boolean>

// 结果只由验证器定：判据里的 verifierId 都要注册；判不了回 void，不算过也不算没过
const verifiers = createVerifierRegistry()
verifiers.register('tests-pass', async ({ workspaceRoot }) => {
  if (!workspaceRoot) return { kind: 'void', cause: 'verifier-unavailable', detail: '没有工作区', evidence: {} }
  return (await testsPass(workspaceRoot))
    ? { kind: 'pass', credit: 1, evidence: {} }
    : { kind: 'fail', credit: 0, failureClass: 'execution-alignment', reason: '测试没过', evidence: {} }
})

// 内置探测器；要按工具名判的两类由宿主给名单，不给就不出对应判词
const detectors = createDetectorRegistry()
detectors.registerBuiltins({ interactiveToolNames: ['ask_user'] })

const archive = await journeyRunner.runJourney({
  jobId: 'nightly',
  suiteId: 'my-product',
  trial,
  journey,
  driver: labDrivers.createPolling(adapter, { confirmation: 'reject' }),
  detectors,
  verifiers,
  workspaceRoot: '/tmp/agent-lab/workspace',
  sourceCommit: null,
  consumerCommit: null,
})
// passed 为 null 是判不了；环境原因的丢弃在 drops 里，不进分子也不进分母
console.log(archive.legs.map((leg) => [leg.legId, leg.passed]), archive.drops)
await labArchives.writeRunArchive('./runs', archive)
const html = labReports.renderRunReportHtml([labReports.createRunReportModel(archive)])
await labArchives.writeReportFile('./runs/report.html', html)
```

```ts
import { labArchives, labWire, realTaskWorkload } from '@velaros-ai/agent-lab'

// 宿主把产品里一次普通运行归一成真实任务记录：任务身份、执行跨度、验收、产物与用户反馈
declare const captured: unknown

const record = labWire.parseRealTaskRecord(captured)
const assessment = realTaskWorkload.audit(record)
// outcome 只看验收断言与用户反馈，health 只看执行过程，verdict 是两者合起来的一句话
console.log(assessment.outcome, assessment.health, assessment.verdict, assessment.findings.length)
await labArchives.writeRealTaskBundle('./audit/task-1', record, assessment)
```

```bash
velaros-agent-lab audit-record record.json --output ./audit
velaros-agent-lab run --job job.json --runtime ./agent-lab.runtime.mjs
velaros-agent-lab report runs/ --output report.html
velaros-agent-lab compare runs/ --a internal --b codex
velaros-agent-lab certify runs/ --policy policy.json --subject subject.json --executor internal
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/agent-lab` | Node | 跑旅程 `journeyRunner`、驱动 `labDrivers`、归档 `labArchives`、报告 `labReports`、统计 `labStatistics`、认证 `labCertification`、真实任务 `realTaskWorkload`、自适应战役 `adaptiveCampaign`、线格式校验 `labWire`、命令行 `agentLabCli`，两个注册处的工厂，注入面（驱动、轮询适配器、验证器、探测器、套件运行时） |
| `@velaros-ai/agent-lab/contracts` | 任何进程 | 线格式的常量表（schema 身份、枚举、上限 `AgentLabLimits`、缺省阈值）与全部载荷的数据类型 |

## 约定

- 不认宿主：包里只有通用轮询驱动（预算、审批策略、稳定空闲判定都在它里面，适配器只报原生状态）；认自己协议的驱动由宿主实现，`labDrivers.register` 登记、`labDrivers.create(id)` 取。不读环境变量，只依赖 `zod`。
- 判据引用的验证器、旅程声明的门探测器没注册，或试验的旅程 id、版本和定义对不上，`runJourney` 当场抛错；驱动报不出能力或身份、开会话或准备工作区失败、验证器回 `void`，都记进 `drops`，不抛。
- 分数与通过是两项事实：没有可判权重时两者均未知；真实门失败不能被满分抹掉，非门诊断也不充当能力失败。可靠性只认完整且唯一覆盖已声明段的真实门结论，丢弃与不可判单列；报告与比较共用整程加权分数，缺段、未知或丢弃保持 `null`。
- 段内抛错折成 `unavailable` 收敛结局，旅程停在那一段、照样出归档；会话不论走到哪一步都关一次，关失败记成一条判词。`runJob` 一个试验失败就停止派发、等在飞的收尾，再抛第一个错。
- 线格式不合法、run id 不能当目录名、评估不属于这条记录、复跑用例缺复核过的提示词、隔离工作区或验收门时当场抛错；判结果看结构（`drops`、`settleOutcome.kind`、`verdict`、退出码），不看文字。
- 运行归档读写只接受当前 `agent-lab/run@3`。发现仅读取 `report.json`，只有文件缺席才跳过目录；JSON、schema 或读取故障直接失败，不读取 `progress.json` 或把坏 v3 当旧格式。旧实验数据保留原件，不读取、转换或迁移。
- 真实任务的 `outcome` 只由验收断言与用户反馈定：用户拒绝或有断言失败是 `fail`，断言全过才是 `pass`，一条断言都没有是 `unknown`；结果过了但执行不健康是 `verified-pass-with-issues`。`renderRealTaskReportHtml(assessment)` 只展示闭集状态、现有数值与问题分类/严重度计数；不嵌入任何自由文本、标识、提示词、回答、绝对路径或产物正文。完整记录、发现说明与来源原样保留在本地 `record.json` 和 `assessment.json`，三种内容分类使用同一 HTML 边界。
- 命令行不抛错，问题都折成 stderr 与退出码（0 正常、1 失败、2 判不了）；`run --runtime <模块>` 要求模块导出 `createAgentLabRuntime` 或默认工厂，返回 `AgentLabRuntime`。宿主接入见 [接入手册](../../docs/agent-lab/integration.md)。
