# Platform 运行主链

正式入口为 `@velaros-ai/velaros.createRuntime`。主模型输出带显式边界的 ScriptAct 文本；宿主通过 `session.submit` 驱动循环，通过 `session.script / observe / execute` 直接调用同一套程序检查、发布和运行机制。

运行状态通过数据库无关的 `ContextStorage` / `StoreStorage` 注入。默认 SQLite 在实际创建适配器时加载，替换后端使用同一个 `createRuntime({ storage })` 入口；事务、连接生命周期和验收要求见 [存储适配规范](./storage.md)。

## 实际执行顺序

1. `ActRunService.submit → ActLoop.submit` 校验文字/图片/文件引用，归档用户原始输入，取得并续期任务租约；模型通过 memory.read 召回原文，通过 memory.organize 声明整理意图，Runtime 校验并发布派生摘要。
2. `RuntimeSession.prepareObservation` 运行当前稳定观察版本，保留其实际结果、附件和观察安全反馈。
3. `ContextMemory.project` 统一组装 task/workspace/observation/recent/runtime 五区。`ProgramContext` 提供当前源码、观察输出、有效结果租约和 diff；`RecentContext` 提供段内历史、卷与目录。组装器加入版本化工作笔记、分区占用和材料进出报告，生成可读 prompt 与内部结构化帧，固定投递与租约身份。
4. `ScriptTurnDecoder` 固定随机帧标记、协议配置和宿主输入快照；本帧协议与标记放在最后一条消息末尾，系统提示在会话内不变。`ActLoop` 按供应商实测用量校准估算，按剩余轮数决定是否封段。`ProviderRequestCompiler` 封存本轮说明、材料与真实图片并检查最终发送预算。材料缩减仍不够时返回 `context_blocked`。
5. `AiSdkModelDriver` 使用 AI SDK `streamText` 的普通文本模式。实际供应商请求没有业务工具表或 JSON responseFormat；图片仍作为独立多模态部分发送。驱动报告原文增量、用量（含缓存读写）和真实结束原因，并把会话缓存键与缓存断点翻译成各家字段。
6. `ScriptTurnDecoder.push` 将正文流和程序预览分开。只有正常 stop、流完整结束、全部段闭合且声明合法，才接受响应、保存原文并确认帧。确认只扣除该帧实际包含且租约身份相同的结果。
7. `RuntimeSession.invokeBatch` 先检查全部观察及执行候选；任何一个失败都不会派发本批代码。全部通过后，经 ContextStorage CAS 发布版本与执行占位；每个 execute 块有独立 executionId，即使源码相同。
8. 默认逐块等待；`async:true` 交给会话持有的有界后台队列。脚本仍通过 `KernelScriptSession`、原隔离 runner 和唯一 Kernel 调用能力。能力 schema、权限、版本前提、journal、结果规范化保持同一条链路。
9. 结果和图片保存到原 ContextStorage，下一帧读取。后台结果不会修改已经发送的帧。工作响应提供 observe、execute 或 done 控制决策；需要用户回答时使用 interaction。没有在途任务的纯正文响应进入有界协议修复；有后台任务时可用进度正文等待任务事件。`done` 请求完成，Runtime 等待在途任务、补投递新结果，再检查未知效果、证据版本和领域验收。

纯协议错误最多重试同一帧两次，保留标记和输入快照，不重跑观察、不扣租期。传输中断、取消、length 或未知结束原因不能授权执行。每次协议尝试结束都会取消对应模型流。

## 模型原文示例

这里用固定示例标记；实际值每帧生成并随请求保存。

````text
我先读取当前值。
@@s7f3a9c2d observe
import { output } from 'velaros';
// 持续观察当前任务需要的信息。
output({ stage: 'checking' });
@@s7f3a9c2d

@@s7f3a9c2d blobs("payload")
const message = `Hello, ${name}`;
console.log(message);
@@s7f3a9c2d

@@s7f3a9c2d execute({ async: true, retain: 2, input: { label: "source" } })
import { input, blobs } from 'velaros:program';
import { output } from 'velaros';
output({ label: input.label, source: blobs.payload });
@@s7f3a9c2d

稍后检查结果。
````

完成声明为 `标记 done` 或 `标记 done()`。它是无载荷单行声明，之后允许继续普通 Markdown。普通代码围栏不参与派发；当前帧保留标记行始终具有协议含义。未知声明、动态头部表达式、重复字段和未闭合段都会报错。

`observe / execute` 支持裸源码、`sourceRef`、精确 `edits`、modules、input、blobs。引用或增量编辑使用空载荷；完整程序包使用 `format:"program"` 的 JSON 载荷。`observe({clear:true})` 配空段清除稳定观察。`blobs("名称")` 在本响应内唯一，自动绑定所有程序；头部和尾部各自的分隔换行不属于载荷，其他内容逐字保留。

## 真实返回内容

下一帧的内部材料包含 `schemaVersion/id/frameId/partitions/memoryStatus`。五区中的观察和结果带源码引用、结果引用、剩余曝光次数、实际时间和截断信息；workspace 保存稳定键、版本和驻留笔记，runtime 保存 jobs、mandatory、progress、programFrame。模型 prompt 直接排版源码和输出；历史消息由来源元数据和原始正文组成，代码不再嵌在多层转义字符串中。内部帧继续保留 JSON，历史正文在消息通道与当前 prompt 之间只发送一份。图片的字节进入图片部分，文字中只保留来源说明。

容量预警触发有界整理。整理模型只提出派生展示，Runtime 验证原文依据、快照版本及完整请求容量后发布。自动整理的摘要和笔记呈现按成功业务轮过期，经验证的 `maxChars` 则保留到同任务下一份策略或任务切换；后续每轮仍采集当前观察。这样可以维持可发送的容量，又不会把临时判断永久当成当前事实。

宿主事件包括 `text`、`program`（start/delta/end 预览）、`usage`、`state`、`verification`、`error`。程序预览不代表程序执行成功。宿主直接调用 `script` 时仍返回单次 `ScriptSubmissionReceipt`；模型多块提交的持久回执使用 `executions[]`。

## 职责与实现文件

| 文件（相对 packages） | 职责 |
| --- | --- |
| `agent/src/impl/ActLoop.ts` | 有序模型回合、重试、取消、任务续期、事件等待、完成判定 |
| `model/src/impl/requests/ProviderRequestCompiler.ts` | 实际文本/图片请求、审计指纹和预算 |
| `model/src/impl/requests/AiSdkModelDriver.ts` | 供应商文本流；通用结构化消费者仍可请求 JSON |
| `velaros/act/runtime/impl/ScriptTurnDecoder.ts` | 增量协议分流、整份响应校验、原文与输入绑定 |
| `velaros/act/runtime/utils/script-protocol.ts` | 字面量 AST、配置校验和同源协议说明 |
| `velaros/act/runtime/impl/RuntimeSession.ts` | 全批预检、执行身份、后台队列、观察和恢复 |
| `velaros/act/runtime/impl/ProgramContext.ts` | 源码版本、CAS 发布、投递清单和曝光租约 |
| `velaros/act/runtime/impl/ContextMemory.ts` | 五区组装、工作笔记与版本 CAS、材料进出基线 |
| `velaros/act/runtime/impl/RecentContext.ts` | 段内历史（只追加、冻结渲染）、封卷、卷目录与按引用召回 |
| `script/src/impl/ScriptPackageCompiler.ts` | 从当前授权和同一包映射生成声明与运行代理 |
| `velaros/act/system/impl/SystemCatalog.ts` | 系统包发现、成员合同及授权后分页 |
| `velaros/act/runtime/impl/ComposedRuntime.ts` | 单一 Kernel 装配；实例内写操作串行闸门 |
| `context/src/impl/ContextViewSession.ts` | 任务所有权、各执行的决策视图、真实证据验证 |
| `script/src/impl/KernelScriptSession.ts` | 原检查器、增量编辑、隔离执行和能力桥接 |

自管理模块集中在 `act/system/`，由 `SystemModules` 装配并通过 `velaros:system` 使用：modules 发现实际能力，memory 统一维护工作笔记、原文召回、结果驻留和长期记忆，store 管理持久对象、任务引用、共享材料与消息订阅。领域能力仍按完整模块名导入。观察模式阻止已知写效果及笔记修改；受限命令的保护范围由宿主实现如实报告。

## 宿主配置

```ts
const runtime = await createRuntime({
  storage, runner, model, modules,
  context: { sources, completion },
  protocol: {
    markerPrefix: '@@s',
    names: { blobs: 'blobs', observe: 'observe', execute: 'execute', done: 'done' },
    concurrency: 4,
  },
  inputs: sessionId => ({ taskArgs: getTaskArgs(sessionId) }),
});
const session = await runtime.openSession('session-id');
for await (const event of session.submit({ text: '检查这张图片', images })) {
  // text 展示正文；program 展示代码预览；state / verification 展示真实运行状态。
}
```

`inputRef:"host:taskArgs"` 读取本帧快照，脚本内部通过 `velaros:program` 访问冻结 input。宿主 `inputs` 是会话级授权口，不应将凭证作为可展示参数注入。仅图片输入和原来的字符串 submit 都可使用。

## 恢复与边界

队列、源码与结果共用既有存储。进程中断后通过 `session.reconcile()` 核对 journal 和保存结果：确认未派发的任务取消；已知结果恢复；未知效果继续阻塞。没有自动重放整段脚本的恢复路径。

写闸门默认串行覆盖同一 Runtime 实例内登记为 write 的能力，包括受限观察命令。宿主可经 effectResources 声明完整的规范化冲突资源集合，让互不冲突的操作并行；未声明范围的操作仍与全部写操作互斥。多个进程及外部程序之间仍依赖领域锁、权限和资源版本前提。异步读取可以并发。通用命令、网络与 UI 操作没有统一回滚或绝对无副作用保证。

主任务、高级搜索和业务子 Agent 通过同一 ContextMemory 和 ScriptAct 循环工作。宿主配置笔记份额、单条新历史份额和封段时保留的近期记录数，搜索默认保留更多近期记录；上下文按剩余轮数封段（见 `long-running-context.md`）；执行预算与真实来源验证继续共用原链路。用户原始输入支持意图摘要和引用投影。完整策略见 `context-management.md` 和 `advanced-search.md`。

详见 [文本协议](scriptact-text-protocol.md)、[结果租约](script-context-leases.md)、[精确编辑](script-incremental-edit.md) 和 [实现差量](../engineering/scriptact-text-protocol-delta.md)。

正式 Runtime 的外部验收入口是 `bun run eval:act --model-config /path/model.json --output /path/results`，由仓库脚本装配现有 Agent Lab、Project、Model、SQLite 与隔离执行器。文件真值和 Kernel 操作回执共同验收；原始回合通过 session.trace 归档。用法与已完成验证见 [长任务与评测接入](../engineering/act-long-run-eval-delta.md)。
