# @velaros-ai/velaros/act/runtime

Act 运行时：把模型、脚本执行、Kernel 与上下文存储装成一条执行链，宿主用 `createRuntime` 开会话、交用户输入、收运行事件。它承载 velaros 包的根入口；模型自管理的 `velaros:system` 在 [act/system](../system/README.md)，搜索与子任务在 [act/search](../search/README.md)、[act/agents](../agents/README.md)。 模型普通 exec 按批次依赖顺序运行，默认等待最多 10000 毫秒后返回稳定作业身份；显式 async:true 立即后台，async:false 优先等待完整结果；新输入、并行程序收束或子任务进展可提前返回稳定执行身份，原程序继续。宿主 execute 等待完整结果。返回窗口独立于程序计时；executions 端口核对当前任务的状态、流输出、游标与定向停止。控制通道与普通进程槽、副作用写锁分离，权限与效果回执继续经共享 Kernel。

## 用法

```ts
import { createRuntime, createNodeExecutionEnvironment } from '@velaros-ai/velaros'
import { createLocalShellHost } from '@velaros-ai/velaros/execution/local'

// 宿主给：模型凭据，项目目录与状态目录（都是绝对路径，状态目录在项目之外），以及怎么问用户
declare const apiKey: string
declare const projectRoot: string
declare const stateDir: string
declare function askUser(message: string): Promise<string>

const shell = createLocalShellHost({cwd:projectRoot, processConfinement:{mode:'workspace-write',workspaceRoot:projectRoot}})
const runtime = await createRuntime({
  node: createNodeExecutionEnvironment({cwd:projectRoot, directory:`${stateDir}/node`, host: shell}),
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
  await shell.dispose()
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

标准 Node 会话支持等价的原生 JSON 工具与自定义文本控制段。`createRuntime({ protocol: { transport: 'tools' } })` 选择原生工具，`transport: 'text'` 选择文本协议；省略时使用公开的 `DefaultScriptProtocolTransport`，驱动声明不支持工具时自动使用文本，显式要求工具而驱动不支持时返回错误。主会话默认开放 execute、observe、blobs、done，受限会话仍按 `allowed` 裁剪。默认值为 `tools`，依据及费用覆盖限制见 [2026-10-07 双路真实任务评测](../../../../docs/engineering/scriptact-protocol-ab-20261007.md)。

原生入口为 `exec({code, options?})`、`observe({code, options?})`、`blobs({name, text})`、`done({message?, completion?})`。文本入口仍使用本帧标记加同名声明（execute 对应 exec），闭合段承载裸源码或原文。两者共用参数绑定、来源引用与编辑、快照观察、异步调度、结果租约和显式完成判定；工具调用与真实回执按各自身份持久配对。原生 exec 与 observe 分别生成参数 Schema：async/retain 属于执行，snapshot/refresh/clear 属于观察。程序与原文只能在整份响应校验通过后派发。完整结束并已回收的进程返回非零码时，保留失败回执并继续本批独立程序；取消、超时、宿主故障与未知效果仍停止后续派发。依赖步骤应放在同一程序中顺序 await。有后台程序或子任务待处理时，模型仅回复进度即可等待；本地程序、子任务或共享状态任一进展都唤醒父任务，结束等待保留其他工作。

模型说明由共同运行语义和所选传输的用法组成，按 `allowed` 与 `names` 同步裁剪、命名。原生模式说明同一响应的多个调用、`code/options` 字段、JSON 转义与 `blobs` 的 `name/text`；文本模式说明本帧控制头、裸源码/原文段及闭合行。两套说明各自给出观察整体替换、编辑、刷新和退订的对应写法；原生 JSON 示例经过实际解码器验证。共享参数校验的修复错误采用通用的源码与选项术语。

宿主可在 `agents.onEvent(job, event)` 接收子任务有序的正文、思考与程序增量；`job.sessionId`、`parentSessionId` 标识子、父会话。回调只用于展示，收到隔离副本，异常不影响执行；恢复和结果仍从持久追踪读取。应用能力从 `process.env.VELAROS_HOST_DIR` 定位 `index.json`，`capabilities` 中每项的 `documentation`、`operationDirectory` 相对该目录根解析。保存的脚本和 Node 子进程使用同一包名导入。默认业务子任务继承 Node 和协议选择；自定义 `AgentProfile` 使用 `node: true` 显式继承操作系统范围，能力目录同时遵守 `modules`。维护和观察使用受限执行器。审批由 `createNodeExecutionEnvironment.authorize` 处理，能力调用还经过 `createRuntime.authorize`；宿主的实际约束证据随 Node 回执返回。

自动封卷叙事优先将原始需求、当前事项和整卷工作材料完整交给结构化模型调用，生成事实摘要、本卷新增未解事项与失败尝试。材料标出本卷完整可见的真实执行见证；模型可选用这些结果中的唯一原文引文或一层 JSON 字符串值，逐项关闭已有 question。宿主将解码引文映射回不可变原文的 UTF-16 区间，核对原文与解码值之间的唯一性和原文长度上限，再绑定当前版本、最新完整用户原文，事项与叙事一起原子发布。用户约束及未提及的事项继续保留，每卷只保存该卷新增问题。只有供应商明确标记可等待重试的瞬时错误才原样重试，最多两次，单次退避不超过三十秒；每次都经过活动与祖先预算，取消立即生效，失败响应及已收到用量分别保留，每卷只发布一次完整叙事。完整材料超出容量时使用交互式分页整理。显式整理与容量压力整理仍可按证据调整各分区的展示。

交互式卷整理沿用相同的新增事项规则；`runtime.modelTool.volume` 持续提供精确的 `(from, through]` 边界，目录只列截至卷末的材料。原始用户输入单独交付，后续材料仍可按授权引用读取；越界材料不能作为本卷已完成工作的依据。

Node 收尾说明要求模型核对原始需求、最终产物和实际验证；涉及改动时审阅最终差异、受影响调用方及兼容约束，按证据报告完成范围。运行结束状态表示协议收束，具体任务的正确性仍由独立验收与产物复核判断。 实现与复核均从既有契约和定义行为的调用链核对兼容语义；新增测试只证明覆盖的样本。现有资料从实际来源读取并在程序内转换；项目会话有工作记忆时，说明如何按用户输入引用读取原文并核对保留内容。原生执行工具将新写的补丁等内容放在 options.blobs；非原子编辑失败后按当前差异恢复。

普通项目任务可将 `context.completion` 设为 `{ kind: 'model-review', artifacts }`。宿主可另传 `validation`，开放独立的 `validate_evidence` 操作；`createNodeCompletionValidationHost` 使用同一产物授权与完整快照，最多两次执行、每次十五秒，回执绑定需求、源码、验证代码及实际环境哈希。只读证据操作与执行操作分别声明效果；取消等待进程清理，版本变化使回执失效。Node 后端目前要求 macOS 每次通过权限预检，条件不满足时明确返回不可用。`CompletionArtifactSource.capture` 提供授权工作区的完整 UTF-8 文本或明确的 `metadata: { bytes, sha256 }`，指纹覆盖全部依赖、授权和 ABA 变化；元数据 text 严格为 `JSON.stringify(metadata)`，只证明存在与字节完整性。可选的 `read(identity, expected, maxBytes, signal)` 按同一快照读取最多 16 MiB 完整原文，返回指纹仍覆盖整个授权集合。Runtime 保留完整用户原文及锚点，按最新纠正区分 `artifact`、`execution`、`constraint`、`audit` 的证明义务；artifact 核验产品功能及状态，包括错误分支、顺序、禁止的副作用和兼容性；constraint 仅用于代理执行过程的行为边界，声明实际观察范围，具体违规仍失败，显式审计仍需证明。推测位置的纠正只改文件映射，保留判据和用户指定路径。清单仅在同一任务、完整原文且经复核确认完整时复用；引用必须来自实际送入模型的连续原文。 用户要求的交付入口在提取和复核时保持一致；生成、渲染、打包及导出范围须由实际内容或配置关联证明，内部源码不能自动替代公开交付。直接交付源码和普通文件仍按原要求核查。 裁定前可配置 `discoverEvidence: true`，独立补读原有契约、公开入口配置和调用链依赖，每轮最多八份文件、最多两轮，总文件、请求预算和复核期限保持原上限。补读身份只用于证据，不改变固定用户要求；缺失路径反馈给定位请求，所有新增文件与原有文件一起参与完整版本及授权核对。默认保持既有流程，启用效果按独立真实模型对照验收。 可选 `counterexampleReview: true` 需要已有 `validation` 宿主，在逐项裁定前共享同一额度实际尝试独立反例检查；最多两项调查意见，已执行结论绑定对应需求的可用回执。调查意见不能当作事实引文；后续裁定同时取得实际断言源码、哈希与回执，再按原始契约判断。该流程默认关闭，尚待真实新案例验证其效果与开销。 独立复核可接收宿主对缺失位置提供的有界目录条目，用于现有位置纠正和补充取证。目录提示不证明文件内容，也不新增交付要求；所选文件仍须重新读取并通过完整版本校验。

复核专用 `retrieve_evidence` 从 `CompletionEvidenceOperationsApi` 生成合同，批量字面查找与读取版本绑定的文件片段及本任务、所属分支的不可变源码/回执对；`execution:task` 可查找已登记的执行正文，目录省略数保持显式。每份片段携带完整来源哈希、UTF-16 范围、总长度和省略标记，目录与元数据不代替正文。具备 read 端口时初始材料为 64000 字节，否则至多 1000000 字节；无效取证参数作为错误回执交回复核模型，占用已有轮次且不能作为证据；裁定必须显式声明布尔需求完整性。同轮多个原生调用合并后最多 16 项，全部参数校验后才开始读取。整个复核最多 4 批、64 项、128 KiB 返回正文，每批 32 KiB，总期限 10 分钟；每次模型请求最多 120 秒并共享父任务预算。完整需求清单始终可见，裁定每批至多八项，随较小的模型输出容量收缩；批次共享取证、执行验证、一次引文纠正及总期限，身份只接受当前批次，最终合并完整覆盖并保留全局需求遗漏。实际编译核对窗口，必要时有界缩短内联材料或连续片段，保留完整哈希及续读位置。版本、目录绑定或授权变化使旧证明失效。`verification` trace 保留请求、取证、失败和真实用量；瞬时故障最多原样重试两次，退避每次最多三十秒。引文的 JSON 转义表示须还原到实际送达的连续原文并保存匹配形式，原始模型响应保持归档；不拼接片段或改写空白、数字。逐项引文纠错最多一次，重验并保留有效裁定，耗尽后仅未核实项保持 unknown；身份、清单完整性或请求失败仍拒绝。取消先收束请求与迟到用量再关闭存储。`independent-model-review` 仅报告当前材料的复核结果，实际运行仍以源码及回执为据；域验收继续通过 `ContextCompletionPort` 提供。

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros` | Node | `createRuntime` 与会话；把能力挂进来的 `createCapabilityModule`、`createProjectCapabilityModule`、`createMcpModule` 与 `createMcpClientConnection`；可靠交付 `createEventDelivery` |
| `@velaros-ai/velaros/contracts` | 任何进程 | 默认协议 `DefaultScriptProtocolTransport`；上限与代际 `VelarosRunLimits`、`McpLimits`、`ScriptLeaseLimits`、`GoalLimits`（宿主用用户正文建目标前按它截断）、`VelarosRuntimeContract`，目标、笔记、追踪、搜索结果这些可移植数据 |
| `@velaros-ai/velaros/renderer` | 任何进程，含渲染进程 | 事件投影 `createActEventProjector` 与展示快照 `ActPresentation` |

## 约定

- Node 的基础说明只在当前可用时提示子任务、深入搜索与整理包的用途，操作合同按需读取。宿主启动整理或搜索专项会话时，直接交付该会话必用的生成合同，固定在其系统前缀并计入容量预算。整理的用户输入与近期工作原文直接进入有界事实区，缺口附原文引用和续页位置；只有实际送达的完整用户输入才能支持约束改写。整理请求自身被截断时，也经 `velaros:context-materials.read` 在同一读取额度内分页补齐；当前请求引用与父快照材料分别校验，读取自身请求不构成父原文送达证明。整理候选使用真实父模型检查容量；超窗时按父循环的 `recoveryChars` 本地重投影一次，可选正文收紧后仍须通过必需材料、任务目标和容量检查，整组补丁才原子发布。合法整理补丁与搜索报告在原生调用成功后进入普通完成核查，无需另发一次模型确认。

- 文本协议的控制段闭合后的连续协议外空白默认最多 4096 个字符，可用 `protocol.maxIdleWhitespaceChars` 调整；超限保存失败原文、停止本次接收并取消，不接受部分程序、不自动重发。源码和 blobs 原文按完整响应预算接收。未结算的上游用量保持未知。

- 请求前缀由完整容量与剩余轮数管理。有序历史开头的用户输入先于段摘要，封段可继续复用其原文前缀；后续用户输入仍与响应、结果按原始顺序交付。实际历史保留时，相同父快照的整理原文按引用与精确范围复用，当前页身份和缺口仍完整显示；历史重建后重新交付正文，审计与发布检查继续使用完整材料。

- 文本协议的模型正文展示首个控制头前的进度和 `done` 后的答复。程序、原文或观察段闭合之后的普通文字只保留在完整审计原文中；它不改变控制决策，也不会额外请求模型重写。
- 默认工作区提供 Project `files` 纯快照计划目录。模型用 `observe({snapshot:{provider:"project",plan:"files",input:{files:[{path:"package.json",key:"package",purpose:"本阶段配置",format:"json",view:"full"}]}}})` 配空段登记，宿主用 `session.observe({snapshot:{provider:'project',plan:'files',input:{files:[{path:'package.json',key:'package',purpose:'本阶段配置',format:'json'}]}}})`。每个业务轮经授权 Kernel 前后真实捕获；完整同值只省固定纯派生及 VM 运行，IO 不跳过。内容指纹不证明历史代次或期间没有 ABA，也不是编辑凭据；任意源码 observe 的可靠代次条件保持。clear、逻辑任务完成或取消退役，重启先重新捕获与派生；refresh 只在接受后生效且不恢复 paused。
- 快照的 `freshness.snapshot` 把本轮真实捕获身份、耗时、读取请求数、正文 UTF-8 字节数与纯派生分开；复用保持原派生执行、结果和时刻。读取数包括前后核对，不包含内核内部额外磁盘读取；未知成本保持缺失。取消立即返回，尚未取得的捕获成本保持未知；物理读取迟到结算后，可按同一捕获身份从 journal 与 Trace 核对真实回执，原失败决策不改写。派生输入仍受 Script 的 400000 个序列化字符预算约束，超出时明确失败，用 range 收窄；完整捕获不保证输入或输出适合当前窗口。
- `velaros:programs` 的 publish/list/describe 连接当前会话的不可变源码归档。发布按名称 revision CAS，检查真实 import 而不执行；list/describe 按当前授权、绑定与重置范围返回目录。绑定相同沿用发布时检查事实，改变后重检。选到的 sourceRef 用原 execute 加本次 input/blobs，每次仍真实执行、生成新回执；目录和内容版本不证明业务效果。
- 新程序、原文、结果、材料帧、整理事项、搜索与子任务句柄采用 8 位十六进制身份；按当前会话精确查询。SQLite 原子签发并保留身份占用，支持并发连接、重启与正文回收；注入存储可提供同等 `allocateReferenceId` 端口，缺省签发器覆盖同存储实例的生命周期。既有长身份继续精确读取，完整内容哈希仍用于校验与复用证明。

- 持续观察缺省每个正常业务轮实际采集。宿主可给 `context.observation` 的 `reuse.probe` 和 `scope`，只对预登记且完整覆盖数据依赖的程序提供可靠代次；`scope` 绑定权限与可见范围，Runtime 另绑定当前任务、授权重置水位和可见模块实例。`providerId` 随版本提供者生命周期更换，`token` 必须识别期间变化后恢复原内容的情况。范围与探测联合超时缺省 250ms，可配置 1–30000ms；`maxAgeMs` 可限制年龄，年龄不证明内容未变。unknown、失败、超时、身份变化、采集中代次变化和不完整采集都继续实际采集。端口必须响应取消；迟到探测结果被忽略，收束前不派发新探测。进程重启先真实采集。`observation.freshness` 与追踪给出 collected/reused/paused、原 executionId/resultRef/observedAt、年龄、原因及本轮真实探测耗时；复用调用不重复计入本轮 invocations，附件沿原引用恢复，缺失时真实采集。
- `observe({sourceRef,refresh:true})` 用空段请求下一正常业务轮真实采集，源码与输入也可同次更新。整份响应的协议及代码预检通过、观察发布成功后刷新才生效；修复轮保持原帧。刷新不恢复 paused，源码实质变化按既有健康规则恢复；未变化的源码登记保留健康状态。阶段性观察按业务目的更新或 clear，注明退役条件。
- 工作指令按正确完成任务、控制端到端耗时与完整费用组织执行。参数已知且无需中途判断的操作合入一个 execute；独立只读查询收集各项结果，有依赖的编辑与验证顺序执行，失败先保留诊断并停止依赖步骤。项目编辑直接复用 read/search 或 select 的目标，程序内计算新正文并一次 patch 提交相关改动；先处理读取缺口与 blocked，版本变化重新定位。新读结果影响编辑判断时先交付材料，再生成依赖程序。编码验证先按改动、受影响调用方和项目要求确定必要范围；扩大或重复检查须有新增改动、关联失败、未解决风险或明确要求，环境失败保留诊断并核对必要检查是否受阻。Shell 使用当前环境的实际语法和可用工具。指令收益以真实任务的完整尝试记录核对。
- Node 子任务的派发输入含有界的父任务原文摘录，原始顺序、后续补充及明确分工一起进入普通任务正文。全文和附件通过环境中的 `parentTask` 索引按需读取；摘录的来源及总长明确，UTF-16 裁剪保留完整字符。续跑按当前父任务重新建立快照。
- 读取围绕待解决的问题定位文件、函数与行范围，在展示预算内合并必要片段并保留来源。代码与普通文本使用对应的 output 类型，其值为字符串；对象使用 JSON，指引以拆分 `stdout` 与其余回执字段的示例说明正文、状态和诊断的交付。多份结果分别使用独立 key。展示截断后按归档引用补齐缺口，来源变化或需核实当前状态时重读来源。`memory.read({ ref, pointer, offset, limit })` 按展示中的字段路径直接读取执行结果；字符串字段返回原文，其他值返回 JSON，字符偏移及引用字符数针对选中字段的 UTF-16 正文，与展示行号分别核对；按每页回执的 `offset + text.length` 续读，到该页 `totalChars` 停止。省略 `pointer` 继续读取完整归档。脚本已读取的材料仍须输出供模型判断；`required` 用于少量须完整可见的关键事实，必要材料与诊断保持交付，过时结果才释放。
- 独立完成复核按固定需求分批裁定，当前批次与下一批的首次只读请求最多两个并行。每次请求固定其实际收到的材料和证据；取证、验证、纠正与最终报告仍按批次结算并共享原有上限。取消或失败先收束已派发请求及真实用量，再释放存储。
- `workspace` 是已有目录的绝对路径，`dataDir` 是绝对路径且按真实路径在工作区之外；不注入 `storage` 时 `dataDir` 必填。不合要求抛 `VALIDATION`。
- 给了 `workspace` 或声明式 `model` 就按工作区预设装：项目能力与项目证据来源、`worker` 子任务、`standard` 搜索档位；给了 `dataDir` 还带 `dataDir/memory` 下的长期记忆。`project` 给 `{ code: true, images: true }` 就在同一个项目内核上另挂 `velaros:code` 与 `velaros:images`（`code` 也可以直接给代码图谱后端）；项目事务、代码查询与看图由宿主配置和项目根直接装配，空 Skill 环境也可使用；语言服务按所选语言 Skill 装配；`project`、`agents`、`search`、`memory` 设成 `false` 分别关掉；没有 `workspace`、`model` 又是注入的驱动时，子任务与搜索只在显式配置时才开。
- 声明式 `model` 要有 `model` 与 `apiKey`，`baseURL` 是不带凭据和查询串的 http(s) 地址，`limits` 的输入、输出加安全余量不能超过总窗口；凭据只用来建驱动，不进模型材料与追踪。
- 业务能力经 `modules` 挂；`velaros:system` 及其成员、`velaros:program`、`velaros:context-materials` 是保留身份，长期记忆只能经 `memory(sessionId)` 装；给了 `workspace` 又自己挂 `velaros:project` 或 `project` 来源（没设 `project: false`）也抛 `VALIDATION`。
- 会话 id 第一次 `openSession` 时与工作区真实路径原子绑定，换工作区重开抛 `WORKSPACE_BINDING_MISMATCH`；`project: false` 也保留这份绑定。
- `submit` 在执行、租约与收尾都结束后才交出终态 `state`（`completed`、`cancelled`、`failed`、`context_blocked`），它是最后一个事件；失败先交一个 `error` 事件，存储这类基础故障在交出这两个事件之后还会从迭代器抛出。
- 效果不明的写操作不挡运行：照实留在结算事实里给模型看，运行照常推进、照常收尾，脚本不会被重放。上次停在执行中途（进程退出、被取消）时，下一次 `submit` 或 `script` 开始前自动按持久日志收拾（能力登记了核对器的照核对结果记），不用宿主出手。
- `interaction` 用 `answer` 回答，`runId` 不对、重复回答、运行已结束或取消都会被拒绝；运行中 `steer` 追加输入、抢占还没接纳的模型回复，`cancel()` 立刻取消。
- `authorize` 在每次派发前调用，抛错即拒绝、操作还没执行；写操作默认互斥，`effectResources` 给出完整的冲突资源集合后，互不相交的才并行。
- `instructions` 是宿主可信的产品指令（身份、界面语言、模式），追加到主会话说明并计入预算；它不是授权，专项模型工具不继承，用户输入与文件正文不放这里。
- 主线、支线及专项模型工具按同一实际请求身份结算祖先预算；收尾占位原子转交，排队取消和准备失败释放未派发占位，未知用量保持预留。跨祖先的部分失败先持久保存回执，重启或下一派发前幂等补账，旧任务回执不计入新任务。专项脚本受活动执行期限约束，模型单次调用时限单独计算。
- 文本协议的完整固定语法随会话配置进入稳定系统指令；帧尾保留当前标记、允许声明、完整执行示例、完成条件和宿主参数引用。协议修复沿用同帧标记与输入快照，下一业务轮更新帧身份；固定规则与动态内容一起参与实际请求容量核对。
- 文本协议工作回合的基础指令要求先输出本帧允许的控制头与实际程序，再根据回执报告结果。缺少控制决策时，修复提示直接给出当前帧标记和允许的控制头，要求本次修复从控制头开始；未闭合段的修复提示给出逐字闭合行，并要求重新输出完整响应。完整校验通过后才执行。完成声明仍需满足当前任务与目标的完成条件。
- 文本协议完成答复的固定说明与帧尾示例统一要求先输出 `done` 控制行，再写总结和验证结果，避免先写总结后漏掉完成声明。完整响应仍经过协议解析与完成条件核验；提示顺序不改变接纳语法。
- 宿主配置的领域完成核查可返回有界 `report`，逐项保留实际范围、检查时间、证据和产物版本。报告由任务 `completionRef` 召回，`verification` 事件及 renderer 的 `verificationReport` 保留成功报告；旧报告只证明其原目标与原产物版本。 推断的临时文件若仅服务实际执行要求，位置纠正可回到该任务源码与回执；文件交付、明确审计或共享文件要求仍保留文件证据，目录授权不扩大。 定位纠正同时提供宿主已读取的文件身份，宿主执行日志沿执行证据核查。
- 成功交付前重新探测 helper 已核对的产物，后续构建或改动使其失效时返回补验要求。默认 Node 提示要求验证最终交付版本；具体判据与完整依赖范围由宿主的领域验收器提供。
- 帧中核查 `counts`、`completed` 与 `verified` 保留原报告事实；`applicabilityCounts` 单独计数本次探测的 current、historical 与 unknown，缺失探测按 unknown 表达。逐项细节省略时仍保留这两个计数及探测时刻。 核查细节在原额度内优先列失败、未知，再列通过项；`index` 始终指向原报告位置，适用性也按原位置绑定。长名称明确标记摘录，省略项保留数量；`ref` 指向完整报告，额度允许时给出整份 `memory.read` 入参。
- 两种协议的普通答复作为进度材料，`done` 显式申请结束当前任务。有活动目标时，带非空依据的 `done` 先完成领域核查，再将任务、原目标版本和报告一起 CAS 发布。失败、取消或目标在核查期间变化不会提前把目标标为完成；模型也可通过现有 `velaros:system` 的 `goal` 成员读取版本并显式更新状态和依据，`goal.update` 沿用自己的已有合同。已有执行或子任务仍在运行且当前只需等待时，模型仅返回普通文本进度，Runtime 挂起模型调用，等待执行进展、子任务结果或新输入。原生协议的固定说明与帧尾均明确这个入口；需要检查输出或决定停止时再读取状态，沿用既有执行身份。 已有执行可用空代码和 `control:{kind:"wait",executionId,waitMs:60000}` 等待终态；一次最多 60 秒、至多一个等待，独立的 read/stop 通道继续可用。
- 原文块与程序块分别闭合，下一控制头不能代替上一段的闭合行。帧尾按当前许可提示原文块边界；出现嵌套控制头时，反馈指出未闭合声明、当前精确闭合行和整份响应重发要求。协议修复沿用同帧身份，被拒绝响应中已经写好的程序也不会提前执行。
- 闭合标记后允许 ASCII 行尾空格；只对控制行判定生效，源码和原文的空白逐字保留。缺失闭合、非空白尾部、孤立闭合和真正嵌套仍拒绝，控制头长度预算保持有效。
- 模型通过文本协议或原生 Shell/Node 发起执行时，结果共用宿主 `protocol.defaultRetain`，默认使用 `segment` 期限：段内已交付正文保持稳定，结果随历史封段时统一退役，最近保留区内的结果继续进入下一段。上下文容量与剩余轮数决定封段；自动封卷达到六个模型轮次或六份实际执行结果、期间未更新笔记和计划时，由整理支线补写叙事，批量调用同样计入。显式的轮数与 `task` 期限继续跨段生效。宿主 `protocol.defaultRetain` 与脚本显式 `retain` 可指定期限，`memory.release` 可提前释放；保留仍受窗口和展示预算约束，不保证全文驻留。任务结束会释放 `segment` 与 `task` 租约，原文仍可召回，生产操作不重跑。直接调用 `session.execute` 的默认期限为两次实际曝光。
- 已在历史里的结果在工作帧只重复租约状态与缺口；连续成功作业可用 `completed-jobs` 映射逐项保留 executionId 与 resultRef，状态统一为 succeeded，仅在结果正文明确仍在历史且整段编码连同说明更短时使用。活动、失败、未知、未交付正文和带额外字段的作业保留逐条信息；重复身份或映射会改变顺序时也保留原条目。同类成功只读与已提交回执在实际编码更短时可跨执行合并次数与首尾 ID，失败、部分提交、未知效果、诊断与额外字段均逐条保留。完成校验读取完整事实，原始工作帧、历史正文和原文召回不受展示汇总影响。材料原始大小在精简前汇总，度量不会把省略元数据计为零。
- 工作帧的结构化状态采用紧凑 JSON，保留字段、条目顺序和字符串内部原文；代码、诊断及用户输入里的换行与空格继续按原值交付。
- 当前帧列出当前状态与有序列表，未变原文按身份保留在历史。Node 的 task 在完整保留上一请求、当前内容与状态逐字相同且说明明显更短时，直接说明沿用本次请求中最近的完整 task；任一字段或顺序变化、历史重建时重新完整展示。其余当前状态继续逐帧列出。引用信息的展示与原文交付分别标记；只有当前与先前帧都包含原文才声明此前已交付，首次正文即使展示元数据相同也会重新交付。
- Node 自动状态中的子任务交付保留当前身份、状态、错误、正文入口与续跑入口；存在停止诊断时直接显示原因，通用续跑入口只在无阻塞诊断时提供，显式 resume 仍核对原有累计预算与宿主配置。产物目录在实际编码更短时展示为 `artifactCount` 与 `artifactsInManifest`，完整清单经 `delivery.ref` 按需读取。显式子任务查询、原始帧和持久交付清单保留完整产物顺序、重复项与指纹。
- 宿主随 `submit` 给出的持续目标完整保存，模型经 `goal.update` 自行建立目标仍遵守内容上限。工作帧按预算展示正文，或用 `objectiveInRecord`、`reasonInRecord` 的 `ref`、`pointer` 经 `memory.read` 按 UTF-16 范围召回同版本原文；引用不表示正文已读。当前目标跨任务可读，历史版本沿用材料授权；存储、`goal.get`、宿主读取与完成核对始终使用全文。Node 目标正文完整进入工作帧且逐字包含在本次已交付用户输入中时，可用更短的 `objectiveInInput` 定位，身份、版本与状态不变。原生工具会话为活动目标提供 `goalControl`，有依据的 `done` 按完成核查合同收尾。
- 当前状态细节按软预算编译：约束、失败、未知效果、必需缺口与有序身份保持完整；完整的可召回证据正文、读取目录和长差量可显示为片段或引用。`memoryStatus.decisionState` 记录字符计量与 `overBudget`，`runtime.stateDetails` 给出当前任务归档引用和 JSON Pointer，`memory.read` 可精确补读。原内部帧与正文证明不变，小状态保持原值；宿主 `context.memory.stateDetails: 'full'` 提供同源消融。
- 启用段内历史时，最新及段内用户输入的选中正文按原始序号进入用户消息，并标记缓存点；当前原始输入优先使用本次完整投影上限，避免分区份额变化反复改写尚能容纳的原文。动态工作帧只列引用、范围和本次运行归属，完整正文仍留在审计帧。后来的改题排在先前响应之后，重启保留原文，任务切换与授权重置按当前范围重建；容量不足时仍缩短投影并保留召回入口，封段遵循原有边界。`recentRecords: 0` 通过工作帧交付任务正文。实际请求同时核算历史和帧尾，缓存收益以服务商用量确认。
- `residentModules` 选择常驻合同：`{ module }` 提供完整声明；`{ module: 'velaros:project', exports: ['edit'] }` 提供从正式声明生成的选定导出及去重的依赖类型，模型可直接 import 使用。示例经 `modules.describe({ module, template: true })` 按需读取；宿主可用 `template: true` 显式常驻整模块示例。同模块的完整声明覆盖选定项，任一重复项显式启用示例即附带一次。未授权或未挂载的模块忽略，已授权模块的未知导出在请求模型前报 `VALIDATION`。常驻内容随会话配置固定，全部计入请求预算；宿主按任务选择常用操作，减少能力发现往返。
- 段内历史在末尾和最早活跃结果租约之前的最后一条结果消息标记缓存点。租约到期后该结果按引用卡展示，仍可召回原文；缓存标记只影响提供商缓存边界，实际命中率由提供商用量记录确认。
- 其余能 import 的模块在运行说明里列成短索引，每个带模块目录里的一句简介、真实值导出与正文 `contentRevision`；索引按字符配额保留完整条目，明确省略数量，完整目录经 `modules.list` 分页读取；完整常驻的与 `velaros:system` 的成员不重复列，仅常驻部分导出的模块仍列出。相同模块的多个导出可用 `modules.describe({ module, exports })` 合并查询，共同规则和依赖类型只返回一次，模板显式请求。
- `environment` 返回宿主环境条目（如 `{ os: 'macOS 26.3.1 (arm64)' }`），每帧和运行时自己读的当地时间一起放进 `runtime.environment`：`time` 是带时区偏移的 ISO 时间，`localTime` 带星期，`timezone` 是时区名，这三项宿主不能覆盖。它在帧尾，不影响前缀缓存；主会话、子任务和专项模型工具都会带上，回调抛错或返回的不是文本键值时这一帧只给时间。
- `runtime.inventory` 从首帧开始提供当前授权能力的公共导入名与用途、基础包和环境已安装 npm 的实际版本、所选 Skill 的用途。详细接口、模板和包文档从运行时目录按需读取。清单每帧刷新，安装、升级、回滚和删除进入下一模型帧；工作区同名依赖以实际执行入口解析为准。清单计入动态上下文预算，`totals` 保留完整数量，超过展示数量时按目录补读；读取失败给诊断，其他能力照常可见。自定义 Node 宿主的 `acquireRuntime` 也用于读取清单，读取结束释放租约，此时不启动进程。
- `createRuntime` 成功后接管注入的 `storage`，`runtime.close()` 时关闭，初始化失败时连接仍归调用方；`session.close()` 只关这个会话，同 id 再 `openSession` 恢复持久数据；`runtime.close()` 重复调用安全。
- `runtime.trace(rootSessionId, query)` 分页读原始请求、回复、脚本与回执，支线关闭后也能读，不唤醒模型；运行中的回合要重读。每个回合的 `executions` 按声明顺序列出这一回合派发的 execute：`position` 对应该回合第几个 execute 程序事件，`status` 与 `failure`（带出错行）由持久结果和调用回执推出，租约带进这一帧的旧结果不在里面。宿主画脚本卡直接用它，不要解析 `records` 里的内部记录。
- Trace 的 `accounting.modelRequests` 只统计本页请求；`verificationScope: 'session'` 表示核查费用是该会话快照内持久 attempt 的累计总账，包含首请求前、运行终态后和无模型请求的 probe。回合关联只用于定位。同会话各页的总账不可相加，跨快照取最新总账或按 charge ID 去重；未知覆盖保持未知，参考报价与实际收费分开。
- `onMetric` 只收不含正文的计量，回调要快速返回，抛错不影响业务结果。
- 普通执行输出超过展示预算时，保留带来源位置和范围的数组前段、文本片段；小元数据只占实际大小，余量用于正文。旧版结果预览已经截断时，从归档 output 或 rawValue 生成展示，诊断保留，引用指向实际原值字段。完整原值可按引用召回；展示片段不代表已读全文，也不会重新执行脚本。本次真实历史中的原始字符串前缀经过会话、结果、源码、完整材料身份与逐字范围核对后，当前帧只交付新增字符；范围标记保留来源与未读部分，冻结历史逐字不变。
- 根引用卡明确标记 `bodyIncluded: false`，不冻结为已交付结果；容量恢复后正文可以进入历史。已完整保留的普通输出将预算留给新结果，短引用和旧 UUID 引用按同一身份核对，图片附件仍单独交付。
- `createNodeExecutionEnvironment` 给了 `output`，前台命令跑着时每吐出一段就回调一次，带上会话、`executionId` 与 `${executionId}:exec` 输出身份，宿主据此把运行中的输出画在对应的脚本卡上；回调要快速返回，抛错只记日志、不打断命令。Node 环境保持原生子进程语义。非交互命令应明确关闭输入（如 execa 的 `stdin: 'ignore'`）并设置适合工作量的期限；文件搜索传入明确路径。实际输入使用 `input` 或写入后关闭 stdin，避免默认打开的管道耗尽整段程序的执行时间。单次程序缺省采用 `CodeSurfaceLimits.timeoutMs` 的 120000 ms 计时，Node 一次性执行可通过 `exec.options.timeoutMs` 显式申请 1..86400000 整数毫秒；observe 仍受缺省上限约束。实际时限取本次请求、运行器上限与真实父任务剩余时限的最小值并保存在回执；父任务取消与关闭仍生效，普通上下文续段不缩短已受理的程序。宿主可用 `submit` 的 `deadline` 指定本次提交的绝对 Unix 毫秒硬期限；到期取消所属工作，续段不延长。真实模型帧的 `executionTime` 提供观测时间、已知期限与剩余时间，并另列可续期运行窗口；未声明硬期限时保持 null，外部信号仍可提前取消。直接等待子进程也计时；后台受理和子进程 timeout 不延长外层时限，源码引用不继承旧时限。宿主能力回执等待期间停表。长工作保存可恢复进度并分段，或按已授权持续执行能力的合同运行；超时回执给出本次实际程序时限，中断后核对实际进程与存档再恢复。Node 指引还要求后台监控核对进程身份、近期进度、错误输出和退出结果；委派监控时一并传递这些核查。运行中的输出可用于诊断，最终验收绑定稳定产物。存活及预期时长本身不证明有效工作。
- 调用回执里的有界 `diagnostic` 独立投影成观察材料：执行放在对应回执的 `code/detail`，观察放在 `observation.safety`，并保留调用身份。能力调用的诊断随实际回执呈现；成功回执合并保留带诊断的条目，效果、成败和可见租约仍按原始事实处理。
- 执行结果首次进入段内历史时，在该条正文剩余额度内附上完整调用诊断并冻结；当前帧继续列身份、状态、错误码和效果，完全匹配的诊断正文通过 `detailInHistory` 指向历史。状态或正文变化、未知效果、容量不足、旧历史未记录诊断交付或关闭历史时，当前帧仍完整交付诊断。审计保留全部正文，重启逐字复用，租约释放、到期、封段和授权重置遵循结果的可见边界。
- 投影器的 `apply` 收持久事件、按游标去重，`applyLive` 收实时事件、预览不推进游标；交付结束调 `finish()`，重新消费要建新的投影器。
- `createEventDelivery({ persist, deliver })` 先落盘再严格按 append 顺序交付，落盘可以合批；任何一步失败就停止后续交付，首个错误留给 `append`、`flush`、`close`。

- 宿主调试面板可用 `runtime.trace(sessionId, { limit: 1, fullContent: true })` 按回合分页读取完整文本；图片和字节数据仍显示占位。默认查询按 `maxChars` 限制正文。
- 供应商延续状态只跟随完整的原始 assistant 正文；冻结和重启保留原文，封段只续接切点后的状态，授权重置后重新建立。摘录不携带状态，不透明数据不进入工作帧材料。

- 逻辑历史兼容且完整请求可发送时，继续沿用已接受的发送前缀；真实超窗先按权威投影重建当前帧，再回收历史。无可延续前缀时按容量与预测余量规划；任务、源码、结果及其真实交付证明沿用原有保留边界。请求估算的字节分项进入模型请求审计，可用于比较真实任务的上下文组成。
- 整理报告的摘要在报告引用、来源与正文一致且原帧仍保留时，以 `summaryInEarlierFrame` 指向已交付正文；重建历史时完整重发。当前 `unresolved`、失败和待处理请求每帧保留；同一报告的末次结果若重复列出相同待办，以 `unresolvedInCurrentState` 指向当前列表。Node 展示中的待办正文若已逐字出现在同帧 `task.active.items`，可用 `{textAt: "/task/active/items/0/text"}` 这样的标准 JSON Pointer 指向当前正文；指针随当前列表重算，列表顺序与重复次数保留，未匹配或身份不明确时继续显示正文。这些正文共享仅在实际编码更短时使用，原始帧与报告保持完整。
- 自动卷叙事按封卷区间预载原文，引用的证据不能晚于该卷末尾。整理事实区优先容纳有正文的近期页，响应接纳后从尚未送达的位置继续；显式补读的历史页也走同一事实区，引用、偏移和缺口保持原样。预载与补读页重叠时，同一原文范围在一帧只出现一次，所有未覆盖区间继续保留；本地选择不推进送达证明。原文可读和模型实际看到正文是独立步骤，摘要仍属于模型解释。 两种整理路径均要求保留判断来源和验证范围；模型的根因、因果与修复声明缺少对应执行证据时保留为未验证判断，连同矛盾现象与待验证项继续交付，代码改动和其他场景的测试通过不能替代原故障复测。
- 原生调用在完整响应仍处于当前历史时，将同批已展示结果正文绑定回相应 Shell/Node 调用。标准模型驱动直接返回这些正文，历史复用、分页、裁剪、原文召回和交付证明沿用现有记录；重开会话可从持久引用重建绑定。
- 两种传输的普通非零退出在进程和后代完成回收、能力回执落定后保留为失败结果，其余独立调用继续按序执行；取消、超时、信号终止、回收不完整、未知效果的失败与宿主故障仍停止后续派发。有依赖的步骤在同一次调用中处理失败。

- `packageEnvironment` 为 agent 绑定持久 npm 环境；标准 Node 宿主和 `dataDir` 默认装配。安装、更新、替换和删除通过 `velaros:system.environment` 管理，当前会话下一次执行自动获取快照，子任务沿用同一环境与宿主权限。自定义环境通过 `createEnvironmentRegistry` 配置，`false` 关闭。
