# @velaros-ai/velaros/act/runtime

Act 运行时：把模型、脚本执行、Kernel 与上下文存储装成一条执行链，宿主用 `createRuntime` 开会话、交用户输入、收运行事件。它承载 velaros 包的根入口；模型自管理的 `velaros:system` 在 [act/system](../system/README.md)，搜索与子任务在 [act/search](../search/README.md)、[act/agents](../agents/README.md)。

## 用法

```ts
import { createRuntime } from '@velaros-ai/velaros'

// 宿主给：模型凭据，项目目录与状态目录（都是绝对路径，状态目录在项目之外），以及怎么问用户
declare const apiKey: string
declare const projectRoot: string
declare const stateDir: string
declare function askUser(message: string): Promise<string>

const runtime = await createRuntime({
  workspace: projectRoot,
  dataDir: stateDir,
  model: { provider: 'openai', model: 'your-model', baseURL: 'https://api.openai.com/v1', apiKey },
  // 其余能力经 modules 挂进来（createCapabilityModule 等），见各单元的 README
})
try {
  const session = await runtime.openSession('main')
  let status = 'idle'
  for await (const event of session.submit('找出登录失败的原因并修好')) {
    if (event.type === 'accepted') console.log(event.text) // 这一轮被接纳的正文；流式预览在 text、program 事件里
    else if (event.type === 'interaction')
      // 模型的 ask、confirm：一个请求只收一次答案
      await session.answer({ id: event.request.id, runId: event.request.runId, value: await askUser(event.request.message) })
    else if (event.type === 'error') console.error(event.message)
    else if (event.type === 'state') status = event.status
  }
  if (status !== 'completed') console.warn('运行没有完成：', status)
} finally {
  await runtime.close()
}
```

渲染进程把同一串事件投影成界面状态：

```ts
import type { ActRunEvent } from '@velaros-ai/agent'
import { createActEventProjector } from '@velaros-ai/velaros/renderer'

// 主进程按顺序转来的 submit 事件
declare const liveEvents: AsyncIterable<ActRunEvent>

const projector = createActEventProjector()
for await (const event of liveEvents) {
  const run = projector.applyLive(event).runs[event.runId]
  console.log(run.status, run.messages.at(-1)?.text ?? run.preview) // 接纳过的正文；没接纳的只是预览
}
projector.finish() // 交付结束：清掉没接纳的预览
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros` | Node | `createRuntime` 与会话；把能力挂进来的 `createCapabilityModule`、`createShellCapabilityModule`、`createProjectCapabilityModule`、`createMcpModule` 与 `createMcpClientConnection`；可靠交付 `createEventDelivery` |
| `@velaros-ai/velaros/contracts` | 任何进程 | 上限与代际 `VelarosRunLimits`、`McpLimits`、`ScriptLeaseLimits`、`GoalLimits`（宿主用用户正文建目标前按它截断）、`VelarosRuntimeContract`，目标、笔记、追踪、搜索结果这些可移植数据 |
| `@velaros-ai/velaros/renderer` | 任何进程，含渲染进程 | 事件投影 `createActEventProjector` 与展示快照 `ActPresentation` |

## 约定

- 工作指令按正确完成任务、减少模型往返与总耗时、降低总费用组织执行。参数已知且无需中途判断的操作合入一个 execute；独立只读查询收集各项结果，有依赖的编辑与验证顺序执行，失败先保留诊断并停止依赖步骤。编码验证先按改动、受影响调用方和项目要求确定必要范围；扩大或重复检查须有新增改动、关联失败、未解决风险或明确要求，环境失败保留诊断并核对必要检查是否受阻。Shell 使用当前环境的实际语法和可用工具。指令本身不证明请求数或时延收益，收益以真实任务的完整尝试记录核对。
- 读取围绕待解决的问题定位文件、函数与行范围，在展示预算内合并必要片段并保留来源。代码与普通文本使用对应的 output 类型，其值为字符串；对象使用 JSON，指引以拆分 `stdout` 与其余回执字段的示例说明正文、状态和诊断的交付。多份结果分别使用独立 key。展示截断后按归档引用补齐缺口，来源变化或需核实当前状态时重读来源。`memory.read({ ref, pointer, offset, limit })` 按展示中的字段路径直接读取执行结果；字符串字段返回原文，其他值返回 JSON，字符偏移针对选中字段，与展示行号分别核对。省略 `pointer` 继续读取完整归档。脚本已读取的材料仍须输出供模型判断；`required` 用于少量须完整可见的关键事实，必要材料与诊断保持交付，过时结果才释放。

- `workspace` 是已有目录的绝对路径，`dataDir` 是绝对路径且按真实路径在工作区之外；不注入 `storage` 时 `dataDir` 必填。不合要求抛 `VALIDATION`。
- 给了 `workspace` 或声明式 `model` 就按工作区预设装：项目能力与项目证据来源、`worker` 子任务、`standard` 搜索档位；给了 `dataDir` 还带 `dataDir/memory` 下的长期记忆。`project` 给 `{ code: true, images: true }` 就在同一个项目内核上另挂 `velaros:code` 与 `velaros:images`（`code` 也可以直接给代码图谱后端）；`project`、`agents`、`search`、`memory` 设成 `false` 分别关掉；没有 `workspace`、`model` 又是注入的驱动时，子任务与搜索只在显式配置时才开。
- 声明式 `model` 要有 `model` 与 `apiKey`，`baseURL` 是不带凭据和查询串的 http(s) 地址，`limits` 的输入、输出加安全余量不能超过总窗口；凭据只用来建驱动，不进模型材料与追踪。
- 业务能力经 `modules` 挂；`velaros:system` 及其成员、`velaros:program`、`velaros:context-materials` 是保留身份，长期记忆只能经 `memory(sessionId)` 装；给了 `workspace` 又自己挂 `velaros:project` 或 `project` 来源（没设 `project: false`）也抛 `VALIDATION`。
- 会话 id 第一次 `openSession` 时与工作区真实路径原子绑定，换工作区重开抛 `WORKSPACE_BINDING_MISMATCH`；`project: false` 也保留这份绑定。
- `submit` 在执行、租约与收尾都结束后才交出终态 `state`（`completed`、`cancelled`、`failed`、`context_blocked`），它是最后一个事件；失败先交一个 `error` 事件，存储这类基础故障在交出这两个事件之后还会从迭代器抛出。
- 效果不明的写操作不挡运行：照实留在结算事实里给模型看，运行照常推进、照常收尾，脚本不会被重放。上次停在执行中途（进程退出、被取消）时，下一次 `submit` 或 `script` 开始前自动按持久日志收拾（能力登记了核对器的照核对结果记），不用宿主出手。
- `interaction` 用 `answer` 回答，`runId` 不对、重复回答、运行已结束或取消都会被拒绝；运行中 `steer` 追加输入、抢占还没接纳的模型回复，`cancel()` 立刻取消。
- `authorize` 在每次派发前调用，抛错即拒绝、操作还没执行；写操作默认互斥，`effectResources` 给出完整的冲突资源集合后，互不相交的才并行。
- `instructions` 是宿主可信的产品指令（身份、界面语言、模式），追加到主会话说明并计入预算；它不是授权，专项模型工具不继承，用户输入与文件正文不放这里。
- 文本协议的完整固定语法随会话配置进入稳定系统指令；帧尾保留当前标记、允许声明、完整执行示例、完成条件和宿主参数引用。协议修复沿用同帧标记与输入快照，下一业务轮更新帧身份；固定规则与动态内容一起参与实际请求容量核对。
- 工作回合的基础指令要求先输出本帧允许的控制头与实际程序，再根据回执报告结果。缺少控制决策时，修复提示直接给出当前帧标记和允许的控制头，要求本次修复从控制头开始；未闭合段的修复提示给出逐字闭合行，并要求重新输出完整响应。完整校验通过后才执行。完成声明仍需满足当前任务与目标的完成条件。
- 完成答复的固定说明与帧尾示例统一要求先输出 `done` 控制行，再写总结和验证结果，避免先写总结后漏掉完成声明。完整响应仍经过协议解析与完成条件核验；提示顺序不改变接纳语法。
- 原文块与程序块分别闭合，下一控制头不能代替上一段的闭合行。帧尾按当前许可提示原文块边界；出现嵌套控制头时，反馈指出未闭合声明、当前精确闭合行和整份响应重发要求。协议修复沿用同帧身份，被拒绝响应中已经写好的程序也不会提前执行。
- 闭合标记后允许 ASCII 行尾空格；只对控制行判定生效，源码和原文的空白逐字保留。缺失闭合、非空白尾部、孤立闭合和真正嵌套仍拒绝，控制头长度预算保持有效。
- 文本协议的 execute 结果默认使用 `segment` 期限：段内已交付正文保持稳定，结果随历史封段时统一退役，最近保留区内的结果继续进入下一段。上下文容量与剩余轮数决定封段；显式的轮数与 `task` 期限继续跨段生效。宿主 `protocol.defaultRetain` 与脚本显式 `retain` 可指定期限，`memory.release` 可提前释放；保留仍受窗口和展示预算约束，不保证全文驻留。任务结束会释放 `segment` 与 `task` 租约，原文仍可召回，生产操作不重跑。直接调用 `session.execute` 的默认期限为两次实际曝光。
- 已在历史里的结果在工作帧只重复租约状态与缺口；连续成功作业可用 `completed-jobs` 映射逐项保留 executionId 与 resultRef，状态统一为 succeeded，仅在结果正文明确仍在历史且整段编码连同说明更短时使用。活动、失败、未知、未交付正文和带额外字段的作业保留逐条信息；重复身份或映射会改变顺序时也保留原条目。同类成功只读与已提交回执在实际编码更短时可跨执行合并次数与首尾 ID，失败、部分提交、未知效果、诊断与额外字段均逐条保留。完成校验读取完整事实，原始工作帧、历史正文和原文召回不受展示汇总影响。材料原始大小在精简前汇总，度量不会把省略元数据计为零。
- 工作帧的结构化状态采用紧凑 JSON，保留字段、条目顺序和字符串内部原文；代码、诊断及用户输入里的换行与空格继续按原值交付。
- 启用段内历史时，最新及段内用户输入的选中正文按原始序号进入用户消息，并标记缓存点；动态工作帧只列引用、范围和本次运行归属，完整正文仍留在审计帧。后来的改题排在先前响应之后，重启保留原文，任务切换与授权重置按当前范围重建；截断和封段继续遵循原有选择预算，完整原文可按引用召回。`recentRecords: 0` 通过工作帧交付任务正文。实际请求同时核算历史和帧尾，缓存收益以服务商用量确认。
- `residentModules` 选择常驻合同：模块名提供完整声明与用法示例；`{ module: 'velaros:project', export: 'edit' }` 提供从正式声明生成的指定导出及完整依赖类型，模型可直接 import 使用。选定导出不附整模块示例，其余操作仍按需发现；同模块的完整合同覆盖选定项，重复项只交付一次。未授权或未挂载的模块忽略，已授权模块的未知导出在请求模型前报 `VALIDATION`。常驻内容随会话配置固定，全部计入请求预算；宿主按任务选择常用操作，减少能力发现往返。
- 段内历史在末尾和最早活跃结果租约之前的最后一条结果消息标记缓存点。租约到期后该结果按引用卡展示，仍可召回原文；缓存标记只影响提供商缓存边界，实际命中率由提供商用量记录确认。
- 其余能 import 的模块在运行说明里列成一行索引，每个带模块目录里的一句简介（模块声明开头那段说明的第一句），模型不用先翻 `modules.list` 才知道有什么；完整常驻的与 `velaros:system` 的成员不重复列，仅常驻部分导出的模块仍列出，方便继续发现其他操作。
- `environment` 返回宿主环境条目（如 `{ os: 'macOS 26.3.1 (arm64)' }`），每帧和运行时自己读的当地时间一起放进 `runtime.environment`：`time` 是带时区偏移的 ISO 时间，`localTime` 带星期，`timezone` 是时区名，这三项宿主不能覆盖。它在帧尾，不影响前缀缓存；主会话、子任务和专项模型工具都会带上，回调抛错或返回的不是文本键值时这一帧只给时间。
- `createRuntime` 成功后接管注入的 `storage`，`runtime.close()` 时关闭，初始化失败时连接仍归调用方；`session.close()` 只关这个会话，同 id 再 `openSession` 恢复持久数据；`runtime.close()` 重复调用安全。
- `runtime.trace(rootSessionId, query)` 分页读原始请求、回复、脚本与回执，支线关闭后也能读，不唤醒模型；运行中的回合要重读。每个回合的 `executions` 按声明顺序列出这一回合派发的 execute：`position` 对应该回合第几个 execute 程序事件，`status` 与 `failure`（带出错行）由持久结果和调用回执推出，租约带进这一帧的旧结果不在里面。宿主画脚本卡直接用它，不要解析 `records` 里的内部记录。
- `onMetric` 只收不含正文的计量，回调要快速返回，抛错不影响业务结果。
- 普通执行输出超过展示预算时，保留带来源位置和范围的数组前段、文本片段；小元数据只占实际大小，余量用于正文。旧版结果预览已经截断时，从归档 output 或 rawValue 生成展示，诊断保留，引用指向实际原值字段。完整原值可按引用召回；展示片段不代表已读全文，也不会重新执行脚本。
- `createShellCapabilityModule` 给了 `output`，前台命令跑着时每吐出一段就回调一次，带上会话、`executionId` 与调用 `invocationId`（与追踪里的同名字段相同），宿主据此把运行中的输出画在对应的脚本卡上；回调要快速返回，抛错只记日志、不打断命令。
- 调用回执里的有界 `diagnostic` 独立投影成观察材料：执行放在对应回执的 `code/detail`，观察放在 `observation.safety`，并保留调用身份。脚本只输出 stdout 也能看到 Shell 诊断；成功回执合并保留带诊断的条目，效果、成败和可见租约仍按原始事实处理。
- 执行结果首次进入段内历史时，在该条正文剩余额度内附上完整调用诊断并冻结；当前帧继续列身份、状态、错误码和效果，完全匹配的诊断正文通过 `detailInHistory` 指向历史。状态或正文变化、未知效果、容量不足、旧历史未记录诊断交付或关闭历史时，当前帧仍完整交付诊断。审计保留全部正文，重启逐字复用，租约释放、到期、封段和授权重置遵循结果的可见边界。
- 投影器的 `apply` 收持久事件、按游标去重，`applyLive` 收实时事件、预览不推进游标；交付结束调 `finish()`，重新消费要建新的投影器。
- `createEventDelivery({ persist, deliver })` 先落盘再严格按 append 顺序交付，落盘可以合批；任何一步失败就停止后续交付，首个错误留给 `append`、`flush`、`close`。

- 宿主调试面板可用 `runtime.trace(sessionId, { limit: 1, fullContent: true })` 按回合分页读取完整文本；图片和字节数据仍显示占位。默认查询按 `maxChars` 限制正文。
- 供应商延续状态只跟随完整的原始 assistant 正文；冻结和重启保留原文，封段只续接切点后的状态，授权重置后重新建立。摘录不携带状态，不透明数据不进入工作帧材料。
