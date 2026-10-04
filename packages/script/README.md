# @velaros-ai/script

Shell 和原生 Node.js 执行、语法检查与 Kernel 能力桥。模型默认使用标准命令、Node 标准库及工作区依赖；应用能力按需通过普通 ESM import 加载。工作目录、进程权限、审批与回收由宿主控制。

## 用法

```ts
import { createKernelScriptSession, createNodeCodeRunner, type NodeCodeRunnerOptions } from '@velaros-ai/script'
import type { OperationRuntimeApi } from '@velaros-ai/kernel'

declare const host: NodeCodeRunnerOptions
declare const kernel: OperationRuntimeApi
const session = createKernelScriptSession({
  runtime: kernel, runner: createNodeCodeRunner(host),
  sessionId: 'main', executionId: crypto.randomUUID(),
})
const result = await session.run({
  source: `import {readdir} from 'node:fs/promises'; console.log(await readdir('.'));`,
})
if (result.checked) console.log(result.result.process)
```

每个会话执行一次程序。`language: 'shell'` 将正文直接交给 Shell；省略语言时运行 Node.js ESM，支持顶层 await。stdout、stderr、退出状态和有界日志路径随结果返回。跨轮状态与复用脚本使用普通文件。

`VELAROS_HOST_DIR/index.json` 提供当前授权包的名称、用途和 `.d.ts` 路径。模型按需读取正式类型合同，然后使用包名导入，例如 `import {list} from 'velaros:sessions'`。原生 Node 负责标准库、npm、文件导入与模块绑定；能力包由当前授权表生成，每次调用经 Kernel 校验。

宿主 `execute(request, onOutput, signal)` 在 Node 模式下将 `request.bootstrap ?? request.source` 作为 ESM 标准输入，在 Shell 模式下执行 `request.source`。`source` 始终保留审批原文。`mode: 'observe'` 需要实际只读进程口；不可用时拒绝启动。Platform 的 `createShellNodeEnvironment` 复用 Shell 宿主的跨平台约束、输出与进程树回收，Desktop 提供随产品分发的真实 Node。

需要结构化归档时，按需导入 `velaros` 的 `output`；内部参数可从 `velaros:program` 的 `input`、`blobs` 读取。`output` 同步保存有界 JSON 快照，在异常、取消和超时后保留已经完成的输出。宿主观察进程只额外获得本次输出文件和本机会话桥的访问权限。每次执行使用独立目录与凭据。

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/script` | Node | `createKernelScriptSession`、`createNodeCodeRunner`、`nodeSubprocessCodeRunner`、语法检查与 `scriptOutputs` |
| `@velaros-ai/script/contracts` | 任何进程 | 程序、诊断、结果、输出及相关上限 |

## 约定

- 一个会话对象只能 `run` 一次，再调拒绝 `CONFLICT`，下一次执行换新的 `executionId` 重建；`edit`、`check` 不执行代码，可以反复调。
- `scriptPackageCompiler.sliceExports` 按多个真实导出合并类型闭包，模块共同规则始终随切片保留；`index` 给真实值导出和声明、模板正文的 `contentRevision`。正文版本不代表授权或已读证明。
- 自定义包只能导入 Kernel 里挂载且在 `allowedModules` 范围内的模块；Node 标准库和工作区依赖由原生解析器提供，`velaros`（`output`）与 `velaros:program`（`input`、`blobs`）总在；`mode` 原样带进每次 Kernel 调用，程序改不了。
- 能力调用失败在程序里是能 `try/catch` 的异常；码里带 `DENIED`、`PERMISSION` 的拒绝另记进 `result.notices`，程序吞了异常模型也看得见。
- 能力调用期间停表，程序时钟不计入等待宿主回执的时间；超时回 `TIMEOUT`，`signal` 触发回 `ABORTED`，停下时没落定的调用会被叫停。引擎只记账不回滚。
- 源码、`blobs`、`input` 超过 `CodeSurfaceLimits` 直接拒（`check` 抛 `TOO_LARGE`，`run` 回 `failed.code` 为 `TOO_LARGE`），不截断照跑；返回值与日志超预算保留结尾，并在 `result.notices` 里说明。
- `output` 调用时拍 JSON 快照，原值在 `outcome.output`，没调 `output` 时完整返回值在 `outcome.rawValue`；按 key 调展示、重新投影用 `scriptOutputs`，规则见 [脚本输出观察](../../docs/architecture/script-output-observation.md)。
- 展示目录的 `totalChars` 与字段引用的 `chars` 按 JSON Pointer 召回正文的 UTF-16 长度计算：字符串为解码原文，其他值为紧凑 JSON。采集计量 `block.chars` 仍按原 JSON 编码大小计算；分页使用读取回执的 `offset + text.length`，到该页 `totalChars` 停止。
- 输出展示按实际交付编码把正文、目录、问题与省略说明计入整体预算；默认 JSON 保持结构化表示，text 对所有类型独立选择能完整放下的正文。未配置整体上限时，显式 `view.mode: 'full'` 且无数字块上限，按完整选中表示的有界编码申请份额，再由宿主分配；放不下仍交引用。`required` 的自动视图、数字块上限（含零）、整体配置、引用、摘要及选择视图保持原语义。text 在共享份额中先分配 required 和 high，再分配普通块；超出时在该预算内选择完整行或完整条目；短块用不完的份额按既定优先级返还给尚未完整展示的块。结构化结果保留短字段，长文本字段共享剩余预算，片段标明完整行范围与原值 JSON Pointer。块优先级、显式展示上限与原值归档保持各自语义。
- `nodeSubprocessCodeRunner` 是 POSIX Node 宿主的便利入口，使用当前目录和本机 Node；Electron、Windows 以及受限权限执行通过 `NodeCodeRunnerOptions` 注入实际进程端口。`NodeSubprocessRunnerIsReleaseReady` 保持 false，部署权限仍由宿主验收。
