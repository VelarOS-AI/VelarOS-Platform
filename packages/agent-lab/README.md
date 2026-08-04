# `@velaros-ai/agent-lab`

VelarOS Agent Lab 是 host 无关的真实任务评测基础设施。默认输入不是预写题库，而是产品已经执行过的普通任务：
宿主把任务身份、执行 span、独立验收、产物和用户反馈归一成 `RealTaskRecord`；包内用纯函数重算任务结果、
执行健康、问题发现和本地报告，不调用模型。

只有值得长期复现的问题，才被人工审阅并固化成 `RealTaskCase`。原有 Journey / Driver / runner 继续提供
隔离单案例复跑和明确批准的研究矩阵，不再意味着每次改动都应跑固定产品电池。

## 公开入口

| 入口 | 用途 |
| --- | --- |
| `@velaros-ai/agent-lab/workload` | 真实任务记录、确定性审计、案例固化和隐私安全报告 |
| `/archive` | 原子写入真实任务 bundle、案例与 v3/历史运行归档 |
| `/protocol` | Journey / Trial / Observation / Archive v3 严格协议 |
| `/drivers` | 原生执行体 Driver、轮询策略和 Velar Hooks 适配器 |
| `/runner` | 显式单案例复跑、预算和 verifier 注册机 |
| `/detect` | 确定性运行健康探测器 |
| `/report` | Journey 运行的自包含 HTML |
| `/statistics` | 明确研究矩阵的配对估计与可比性检查 |
| `/certification` | 第三方执行体的策略化认证摘要 |

## 真实任务审计

```ts
import { writeRealTaskBundle } from "@velaros-ai/agent-lab/archive";
import {
  auditRealTask,
  parseRealTaskRecord,
} from "@velaros-ai/agent-lab/workload";

const record = parseRealTaskRecord(hostCapturedTask);
const assessment = auditRealTask(record);
await writeRealTaskBundle("./artifacts/task-1", record, assessment);
```

`outcome` 只由独立验收或用户确认决定；`health` 只描述执行过程。结果正确但工具出错、顺序重试或存在
未验收副作用时会得到 `verified-pass-with-issues`，不会被一个总分掩盖。没有验收就是 `unknown`。

`renderRealTaskReportHtml` 不嵌入 prompt、回答、绝对路径或产物正文。宿主决定是否在本地记录中保留这些
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

核心包不依赖 Desktop、Electron、供应商 SDK 或其他 VelarOS 产品包。真实存储采集、命令/文件/browser
验收、隔离快照和用户反馈入口由产品宿主实现。设计与接入细节见 Platform `docs/agent-lab/`。
