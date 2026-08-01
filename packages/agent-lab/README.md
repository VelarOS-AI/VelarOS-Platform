# `@velaros-ai/agent-lab`

VelarOS Agent Lab 是面向连续 agent 旅程的可复现评测、诊断、统计与认证基础设施。它把一次任务定义为
**同一个原生会话中顺序推进的多个里程碑**；传统“一题一会话”评测是只有一个里程碑的特例。

这个包不包含 Desktop、Electron、模型供应商或某一种 agent runtime。产品仓通过公开的 Driver、Verifier
和 Runtime 接缝接入真实执行体；核心只负责协议、预算、观测归一化、确定性判据、归档、报告、统计和认证。

## 安装与公开形态

```bash
bun add @velaros-ai/agent-lab
velaros-agent-lab help
```

公开入口：

| 入口                             | 用途                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `@velaros-ai/agent-lab/protocol` | Journey / Trial / Observation / Archive v3 的类型与严格解析器 |
| `/drivers`                       | 原生执行体 Driver、共享轮询策略和 Velar Hooks 适配器          |
| `/runner`                        | 连续旅程、矩阵 Job、预算账本与验证器注册机                    |
| `/detect`                        | 确定性探测器、`toolCallId` 去重和运行期看门狗                 |
| `/archive`                       | 原子写入 v3、只读解析 v0/v1/v2/v3 历史归档                    |
| `/report`                        | 自包含 HTML 和“未知不显示为 0”的历史报告                      |
| `/statistics`                    | 可靠性区间、配对旅程簇 bootstrap、失败分类与可比性检查        |
| `/certification`                 | 面向第三方 agent / mod 的策略化认证报告                       |

根入口导出以上全部稳定 API。未列出的源码路径不是公开契约。

## 最小连续旅程

```ts
import { parseJourneySpec } from "@velaros-ai/agent-lab/protocol";

export const RefactorJourney = parseJourneySpec({
  id: "refactor-and-recover",
  version: 1,
  title: "重构、验证、再修复",
  description: "副作用和上下文在同一会话中累积",
  tags: ["coding", "regression"],
  space: "project",
  budget: {
    toolCalls: 120,
    workingMs: null,
    wallClockMs: 600_000,
    tokens: 80_000,
    legs: 3,
  },
  setup: {
    adapter: "git-fixture",
    parameters: { fixture: "refactor-v1" },
    hygiene: ["clean-tree"],
  },
  gatingDetectorIds: ["stuck-running-tool", "tool-retry-loop"],
  legs: [
    {
      id: "change",
      title: "完成重构",
      prompt: "重构指定模块并验证。",
      weight: 1,
      blocking: true,
      budget: null,
      continueOn: [],
      driverParameters: {},
      criteria: [
        {
          id: "behavior",
          verifierId: "fixture-tests",
          parameters: {},
          weight: 1,
          gate: true,
        },
      ],
    },
    {
      id: "diagnose",
      title: "处理注入故障",
      prompt: "现在定位并修复新出现的回归。",
      weight: 1,
      blocking: true,
      budget: null,
      continueOn: [],
      driverParameters: {},
      criteria: [
        {
          id: "recovery",
          verifierId: "recovery-tests",
          parameters: {},
          weight: 1,
          gate: true,
        },
      ],
    },
    {
      id: "explain",
      title: "解释因果链",
      prompt: "说明根因、证据与剩余风险。",
      weight: 1,
      blocking: false,
      budget: null,
      continueOn: [],
      driverParameters: {},
      criteria: [
        {
          id: "evidence",
          verifierId: "evidence-contract",
          parameters: {},
          weight: 1,
          gate: true,
        },
      ],
    },
  ],
});
```

任何会改变任务、环境、预算或判据语义的修改都必须提升 `JourneySpec.version`。每份运行归档同时记录
任务、探测器和策略摘要；摘要不一致的结果会被统计层判为不可比。

## 接入新的执行体

实现 `LabDriver`，或者用 `createPollingDriver(adapter, policy)` 只提供原生状态投影。Driver 必须：

1. 为一次 Trial 打开一个会话，并让所有 Journey leg 复用它。
2. 自己声明收敛信号。内部 agent 可以用 agent events；Codex / Claude Code 应使用引擎协调器 idle 或进程退出，
   不能伪造 agent event。
3. 把不能观测的数据面声明为 `partial` / `none`；不允许补 0、空数组或 `false` 冒充已观测。
4. 保留执行体的原生工具、提示和权限行为，并真实报告版本、模型与配置。
5. 在运行期提供可去重的 `toolCallId`；累积调试快照不能逐轮相加。

`createVelarHooksDriver` 是真实 Electron app 的参考适配器。用 `resolveSpace` / `commandExtras` 传产品侧
execution binding，用 `sendParameters` 把产品控制参数与 hook 协议字段隔开；由 Desktop 引擎协调器选择内部
agent、Codex 或 Claude Code。供应商专属字段留在 Driver，不能渗进核心协议。

## 加任务、判据和探测器

- 任务：新增一个纯数据 `JourneySpec`，使用稳定 id，版本从 1 开始；fixture setup 必须可重复且写明 hygiene。
- 判据：向 `VerifierRegistry` 注册函数。Verifier 读取最终磁盘产物或隔离 sidecar 证据；异常归类为
  `verifier-failure`，环境不可用返回 `void`，不能返回 0 分。
- 探测器：向 `DetectorRegistry` 注册带版本的纯函数。相同 Observation 必须得到相同 Finding；是否可运行期
  掐断由 `abortClass` 声明。
- 上下文实验：Driver 直接投影现有 residency ledger 为 `contextResidency`，禁止另建第二套压缩账本。

## CLI

```bash
velaros-agent-lab validate journey journeys/refactor.json
velaros-agent-lab validate job jobs/matrix.json
velaros-agent-lab run --job jobs/matrix.json --runtime ./agent-lab.runtime.mjs
velaros-agent-lab report runs/ --output /tmp/report.html
velaros-agent-lab compare runs/ --a internal --b codex --minimum-effect 0.03
velaros-agent-lab certify runs/ --policy certification.json --subject subject.json --executor mod-x
```

认证 policy 与 subject 同样经过严格 parser；未知字段、越界概率和非 SHA-256 subject digest 会在运行前拒绝，
不会先产出一份看似正式的错误证书。

Runtime 模块公开导出 `createAgentLabRuntime()`（或默认工厂），返回 Journey resolver、Driver resolver、
DetectorRegistry、VerifierRegistry、工作区和两个源码 commit。CLI 每完成一份 trial 就原子写归档；中断不会留下
半份可读的 `report.json`。

## 测量解释

- `pass/fail` 是已观测判决；`void` / `null` 是没被问到或无法得到可信证据。
- 环境与基础设施 attrition 单列，不进入 agent 能力的分子或分母。
- 跨执行体比较要求共享任务摘要、预算、判据、consumer commit 与原生执行行为，并按 Journey 做成对匹配。
- 少于两个 Journey 簇时不给显著性区间；默认结论是 `inconclusive`，不是强行排榜。
- 认证先检查验证器隔离、观测覆盖、完整性、重复次数、可靠性和 attrition，再谈相对基线。

更完整的设计与方法说明见 Platform 文档索引中的 Agent Lab 文档。变更公开协议前先读 `CHANGELOG.md`。
