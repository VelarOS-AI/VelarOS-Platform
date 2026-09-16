# `@velaros-ai/agent-lab`

VelarOS Agent Lab 是 host 无关的真实任务评测基础设施。默认输入不是预写题库，而是产品已经执行过的普通任务：
宿主把任务身份、执行 span、独立验收、产物和用户反馈归一成 `RealTaskRecord`；包内用纯函数重算任务结果、
执行健康、问题发现和本地报告，不调用模型。

只有值得长期复现的问题，才被人工审阅并固化成 `RealTaskCase`。原有 Journey / Driver / runner 继续提供
隔离单案例复跑和明确批准的研究矩阵，不再意味着每次改动都应跑固定产品电池。

## 公开入口

只有两个入口，里面的东西由合同控制（`src/contract/provides.ts` 与 `requires.ts`）：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `@velaros-ai/agent-lab` | Node 进程（评测套件、CLI 壳） | 九件能力的实例、两个注册处的工厂、注入面与全部数据类型 |
| `@velaros-ai/agent-lab/contracts` | 任何进程，含渲染进程与第三方工具链 | 常量表与可移植数据，不碰 Node |

九件能力：`labWire`（线格式校验）、`journeyRunner`（跑旅程与 job）、`labDrivers`（驱动装配与登记）、
`labArchives`（归档读写）、`labReports`（报告）、`labStatistics`（统计）、`labCertification`（认证）、
`realTaskWorkload`（真实任务）、`adaptiveCampaign`（自适应战役），外加 `agentLabCli` 与两个注册处工厂
`createDetectorRegistry` / `createVerifierRegistry`。

## 本包不认宿主

本包不认识任何具体执行体，也不读任何环境变量、凭据文件或宿主数据目录。宿主要塞进来的东西全部在
`contract/requires.ts`：`LabDriver`（执行体驱动）、`PollingDriverAdapter`（轮询适配器）、`LabDriverProvider`
（宿主自带驱动的注册点）、`Verifier` / `Detector`、`AgentLabRuntime` 与 `AgentLabRuntimeLoader`。

```ts
import { labDrivers, createDetectorRegistry } from "@velaros-ai/agent-lab";

// 宿主把认自己协议的驱动登记进来（例如 Desktop 的 Velar Hooks 驱动）
labDrivers.register({ id: "velar-hooks", create: (parameters) => createMyHooksDriver(parameters) });

// 要按工具名判的两类，由宿主给名单；不给就不出对应判词
const detectors = createDetectorRegistry();
detectors.registerBuiltins({
  catalogToolNames: ["tooling:map"],
  interactiveToolNames: ["interaction:ask_user"],
});
```

## 真实任务审计

```ts
import { labArchives, labWire, realTaskWorkload } from "@velaros-ai/agent-lab";

const record = labWire.parseRealTaskRecord(hostCapturedTask);
const assessment = realTaskWorkload.audit(record);
await labArchives.writeRealTaskBundle("./artifacts/task-1", record, assessment);
```

`outcome` 只由独立验收或用户确认决定；`health` 只描述执行过程。结果正确但工具出错、顺序重试或存在
未验收副作用时会得到 `verified-pass-with-issues`，不会被一个总分掩盖。没有验收就是 `unknown`。

`labReports.renderRealTaskReportHtml` 不嵌入 prompt、回答、绝对路径或产物正文。宿主决定是否在本地记录中保留这些
内容；固化案例必须显式审阅 prompt、隔离快照引用和至少一条确定性验收契约。

## CLI

```bash
velaros-agent-lab validate real-task record.json
velaros-agent-lab validate case case.json
velaros-agent-lab audit-record record.json --output ./audit

# 以下只用于显式案例/研究矩阵
velaros-agent-lab validate journey journey.json
velaros-agent-lab run --job job.json --runtime ./agent-lab.runtime.mjs
velaros-agent-lab report runs/ --output report.html
velaros-agent-lab compare runs/ --a internal --b codex
```

装出来的命令是 `velaros-agent-lab`，可执行文件在包根 `bin/velaros-agent-lab.mjs`：它只是壳，把
`process.argv` 与一个动态 import 的运行时加载器交给 `agentLabCli.run(argv, options)`，再把返回的两段文字
写出去、设置退出码；`src` 下没有副作用。

核心包不依赖 Desktop、Electron、供应商 SDK 或其他 VelarOS 包（只依赖 `zod`）。真实存储采集、命令/文件/browser
验收、隔离快照和用户反馈入口由产品宿主实现。设计与接入细节见 Platform `docs/agent-lab/`。
