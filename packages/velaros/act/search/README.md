# @velaros-ai/velaros/act/search

有界的高级搜索：模型用 `velaros:search` 派一项搜索，运行时开一条独立的搜索支线，搜索模型只能用 `velaros:evidence` 在宿主给的来源里检索、读取并登记证据，最后交一份每条发现都引用证据的报告。宿主经 `createRuntime` 的 `search` 选模型与预算档位。

## 用法

```ts
import { createRuntime } from '@velaros-ai/velaros'
import type { ContextSourcePort } from '@velaros-ai/context'
import type { ModelDriver } from '@velaros-ai/model'
import type { SearchProfile, VelarosSearchOptions } from '@velaros-ai/velaros/act/search'

// 宿主给：主模型与搜索模型（搜索可以用便宜些的）、状态目录（绝对路径）、证据来源（比如文档库）
declare const model: ModelDriver
declare const searchModel: ModelDriver
declare const stateDir: string
declare const docs: ContextSourcePort

// 档位是宿主命名的资源上限，模型用 profiles() 看到名字与上限，只能按名字选
const quick: SearchProfile = {
  modelCalls: 8,
  modelTokens: 200_000,
  finalizationTokens: 16_384,
  timeoutMs: 300_000,
  callTimeoutMs: 60_000,
  finalizationMs: 30_000,
  outputTokens: 4_096,
  projectionChars: 24_000,
  sourceQueries: 32,
  candidates: 64,
  reads: 32,
  readBytes: 500_000,
}
const search: VelarosSearchOptions = {
  model: searchModel,
  profiles: { quick, deep: { ...quick, modelCalls: 24, modelTokens: 1_000_000, reads: 128, readBytes: 2_000_000 } },
  defaultProfile: 'quick',
}
const runtime = await createRuntime({ dataDir: stateDir, model, search, context: { sources: [docs] } })

// 搜索跑在独立支线里：从主会话的追踪找到它，再按 sessionId 读它自己的请求与回执
const page = await runtime.trace('main')
for (const branch of page.branches.filter((item) => item.kind === 'search')) {
  const trace = await runtime.trace('main', { sessionId: branch.sessionId })
  console.log(branch.status, trace.turns.length)
}
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/act/search` | Node | 配置 `VelarosSearchOptions` 与档位 `SearchProfile`，报告、证据与读取的数据，运行时用的装配 `searchModule`、`evidenceModule` 及其宿主端口 |

## 约定

- 来源一律来自 `context.sources`（工作区预设自动加上项目）。不给 `search` 时，预设在有模型、有来源时开一个 `standard` 档位；`search: true` 缺模型或来源时 `createRuntime` 抛 `VALIDATION`，`search: false` 关掉。
- 档位的每一项都是正整数，`modelCalls` 至少 2，`finalizationTokens` 大于 `outputTokens`、小于 `modelTokens`，`timeoutMs` 比 `finalizationMs` 加发布预留（`publicationMs`，缺省 1000 毫秒）长；`defaultProfile` 必须登记过。不合要求 `createRuntime` 抛 `VALIDATION`。
- `velaros:search` 给主线与带它的子任务配置；`velaros:evidence` 只在搜索支线里有，只能读来源、不能写，来源能读什么由来源自己的授权定。
- 搜索的调用与 token 计入同一逻辑任务的总额度，支线深度与并发和子任务共用 `modelTools` 的上限；跑到一半撞上档位上限、超时或模型出错也照样交回报告，`status` 是 `partial` 或 `failed`，`stopReason`、`coverage.limitsHit` 与 `gaps` 说明原因，不抛错。
- 报告里每条发现都要引用读过的证据；证据带读到的版本，报告与检查点持久保存，`ref` 跨重启可以 `resume` 续查或 `read`；`read` 的 `current` 模式重读选中证据的现状、不调用模型，内容变了如实标出。
- `searchModule`、`evidenceModule` 是运行时自己用的装配；只有自己拼 Kernel、自带搜索编排的宿主才直接用，传 `SearchHost`、`EvidenceHost`。
