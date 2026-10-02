# @velaros-ai/script

模型写的 JavaScript 程序在这里检查、精确编辑和隔离运行：先查 JavaScript 语法、核对每个 import 都在当前能力声明里，没过一行不执行（类型不查，字段写错由运行时当场报）；过了就在 QuickJS 子进程里跑，每次能力调用都经同一个 Kernel 的权限、效果分类与回执。给装配会话的宿主用；模型面的 `script` 入口、源码版本与结果租约由 `@velaros-ai/velaros` 装配。

## 用法

```ts
import type { OperationRuntimeApi } from '@velaros-ai/kernel'
import { createKernelScriptSession, nodeSubprocessCodeRunner, type CodeProgramRequest } from '@velaros-ai/script'

// 宿主持有的 Kernel：模块注册、权限、效果分类与调用回执都在它那里
declare const kernel: OperationRuntimeApi

// 一次执行一个身份：建一个会话对象，run 一次
const script = createKernelScriptSession({
  runtime: kernel,
  runner: nodeSubprocessCodeRunner,
  sessionId: 'session-1',
  executionId: crypto.randomUUID(),
})

// 程序是 ES 模块：import 拿能力；参数与大段文本走 velaros:program，不写进源码；output 交出结果
const draft: CodeProgramRequest = {
  source: `import { output } from 'velaros'
import { input, blobs } from 'velaros:program'
output({ title: input.title, chars: blobs.notes.length }, { key: 'summary' })`,
  input: { title: '周报' },
  blobs: { notes: '很长的正文……' },
}

// 精确编辑只生成候选：oldText 在底稿里必须唯一，一组全成或全不成
const edited = script.edit(draft, [{ oldText: "key: 'summary'", newText: "key: 'report'" }])
if (!edited.ok) console.warn(edited.code, edited.editIndex, edited.message)
const program = edited.ok ? edited.program : draft

// 只检查、不执行
const checked = script.check(program)
if (!checked.ok) console.warn(checked.diagnostics.map((item) => `${item.line}:${item.column} ${item.message}`))

const stop = new AbortController() // 用户点停止时 stop.abort()
const outcome = await script.run(program, stop.signal)
if (!outcome.checked) {
  // 一行都没执行：import 了没授权的模块，或者语法没过
  console.warn('needsModules' in outcome ? outcome.needsModules : outcome.check.diagnostics)
} else if (outcome.result.failed) {
  // 没跑完：已落定与没落定的调用都列出来，副作用按它们核对
  console.warn(outcome.result.failed.code, outcome.result.completed, outcome.result.unsettled)
} else {
  // 结构化结果读原值；result.value 只是给模型看的有界预览
  for (const block of outcome.output?.blocks ?? []) console.log(block.key, block.value)
}
```

Electron 里默认运行器不起进程：宿主自己起受信子进程，父端交给共享运行器，子进程里跑 `./worker`。

```ts
import { createSubprocessCodeRunner, type ScriptProcess, type ScriptProcessEvents } from '@velaros-ai/script'

// 比如 utilityProcess.fork(worker 入口, [], { execArgv: [`--max-old-space-size=${events.heapMb}`] })：
// 消息、错误、退出码与 stderr 接到 events 上；terminate 杀掉进程并等它真的退出
declare function forkScriptWorker(events: ScriptProcessEvents): ScriptProcess

// 计时、能力桥、输出采集与回收都在共享运行器里；把它当 runner 交给 createKernelScriptSession
export const runner = createSubprocessCodeRunner({ launch: forkScriptWorker })
```

```ts
// worker 入口：单独打包，在子进程里跑，只把宿主的消息口交进来
import { startScriptWorker, type ScriptWorkerCommand, type ScriptWorkerEvent } from '@velaros-ai/script/worker'

declare function postToParent(message: ScriptWorkerEvent): void // utilityProcess 里是 process.parentPort.postMessage
declare function onParentMessage(listener: (message: ScriptWorkerCommand) => void): () => void

await startScriptWorker({ send: postToParent, onMessage: onParentMessage, exit: (code) => process.exit(code) })
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/script` | Node | Kernel 脚本会话 `createKernelScriptSession`，运行器 `nodeSubprocessCodeRunner` 与 `createSubprocessCodeRunner`，输出整理 `scriptOutputs`，以及不经 Kernel 自己装配时用的检查器、单次执行会话与能力端口 |
| `@velaros-ai/script/contracts` | 任何进程 | 上限 `CodeSurfaceLimits`、`CodeProgramEditLimits`、`ScriptOutputLimits`，错误码 `CodeSurfaceErrorCodes`，程序、诊断、结果与输出的数据 |
| `@velaros-ai/script/worker` | 受信子进程 | `startScriptWorker`：建 QuickJS 堆、接父进程消息；不带编译器与父端运行器 |

## 约定

- 一个会话对象只能 `run` 一次，再调拒绝 `CONFLICT`，下一次执行换新的 `executionId` 重建；`edit`、`check` 不执行代码，可以反复调。
- `scriptPackageCompiler.sliceExports` 按多个真实导出合并类型闭包，模块共同规则始终随切片保留；`index` 给真实值导出和声明、模板正文的 `contentRevision`。正文版本不代表授权或已读证明。
- 程序只拿得到它 import 了（直接或经宿主 `packages` 聚合）、Kernel 里挂着、又在 `allowedModules` 之内的模块，`velaros`（`output`）与 `velaros:program`（`input`、`blobs`）总在；`mode` 原样带进每次 Kernel 调用，程序改不了。
- 能力调用失败在程序里是能 `try/catch` 的异常；码里带 `DENIED`、`PERMISSION` 的拒绝另记进 `result.notices`，程序吞了异常模型也看得见。
- 能力调用期间停表，时限只算程序自己的计算；超时回 `TIMEOUT`，`signal` 触发回 `ABORTED`，停下时没落定的调用会被叫停。引擎只记账不回滚。
- 源码、`blobs`、`input` 超过 `CodeSurfaceLimits` 直接拒（`check` 抛 `TOO_LARGE`，`run` 回 `failed.code` 为 `TOO_LARGE`），不截断照跑；返回值与日志超预算保留结尾，并在 `result.notices` 里说明。
- `output` 调用时拍 JSON 快照，原值在 `outcome.output`，没调 `output` 时完整返回值在 `outcome.rawValue`；按 key 调展示、重新投影用 `scriptOutputs`，规则见 [脚本输出观察](../../docs/architecture/script-output-observation.md)。
- 输出展示按实际交付编码把正文、目录、问题与省略说明计入整体预算；默认 JSON 保持结构化表示，text 对所有类型独立选择能完整放下的正文。未配置整体上限时，显式 `view.mode: 'full'` 且无数字块上限，按完整选中表示的有界编码申请份额，再由宿主分配；放不下仍交引用。`required` 的自动视图、数字块上限（含零）、整体配置、引用、摘要及选择视图保持原语义。text 在共享份额中先分配 required 和 high，再分配普通块；超出时在该预算内选择完整行或完整条目；短块用不完的份额按既定优先级返还给尚未完整展示的块。结构化结果保留短字段，长文本字段共享剩余预算，片段标明完整行范围与原值 JSON Pointer。块优先级、显式展示上限与原值归档保持各自语义。
- `nodeSubprocessCodeRunner` 要找得到 Node 可执行文件，在 Electron 里不执行、回 `RUNNER_CRASHED`；`NodeSubprocessRunnerIsReleaseReady` 恒为 `false`，部署环境的隔离边界由宿主验收。
