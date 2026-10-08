# @velaros-ai/context

ScriptAct 的持久上下文：原始记录与材料存成不可变对象，模型的工作集按乐观锁提交，任务检查点与证据视图从真实来源物化，另有共享对象与持久消息的存储端口。普通宿主经 `@velaros-ai/velaros` 的 `createRuntime` 间接使用它；自己装配的宿主直接用这里的工厂，再从 `./node` 拿本地 SQLite 存储。

## 用法

```ts
import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

// SQLite 文件的绝对路径（目录由宿主先建好，测试可用 ':memory:'）；存储由宿主创建与关闭
const storage = localContextStorage({ path: '/var/lib/my-app/context.sqlite' })
const context = createContextRuntime({ sessionId: 'session-1', storage })

// 宿主归档真实事件：正文进不可变对象存储，记录只留引用
await context.append({ kind: 'user', body: '把登录页改成两步验证' })
const output = await context.append({ kind: 'tool', title: 'npm test', body: '12 passed, 1 failed' })

// 模型写带来源的笔记，再按乐观锁替换工作集；提交从下一次模型请求起生效
const note = await context.write({ kind: 'note', title: '失败原因', body: '…', sources: [output.ref] })
const snapshot = await context.inspect()
try {
  await context.replace({
    baseRevision: snapshot.revision,
    baseCursor: snapshot.cursor,
    items: [note.ref],
  })
} catch (error) {
  if ((error as { code?: string }).code !== 'CONTEXT_CONFLICT') throw error
  // 别的实例先提交了：重新 inspect 再决定
}

// 冻结下一次请求的材料；原文随时按引用分页读回
const projection = await context.project(24_000)
const log = await context.read(output.ref, { offset: 0, limit: 2_000 })
console.log(projection.chars, log.totalChars)
await storage.close()
```

任务与证据视图：观察需求登记给真实来源，每步结算后物化成下一轮的 `ModelView`。

```ts
import {
  createContextInvocationJournal,
  createContextRuntime,
  createContextView,
  type ContextSourcePort,
  type ContextStorage,
} from '@velaros-ai/context'

declare const storage: ContextStorage
declare const project: ContextSourcePort // 领域适配器：授权、检索、真实读取与版本核对

const context = createContextRuntime({ sessionId: 's1', storage })
const view = createContextView({ sessionId: 's1', storage, context, sources: [project] })
// 同一存储上的调用日志，交给 @velaros-ai/kernel 的 createOperationRuntime
const journal = createContextInvocationJournal(storage)

const goal = await context.append({ kind: 'user', body: '确认 src/a.ts 的改动已生效' })
await view.begin(goal.ref)
await view.startStep('step-1')
await view.request({
  kind: 'direct',
  target: { kind: 'resource', sourceId: project.id, resourceId: 'src/a.ts' },
  purpose: '核对改动',
  importance: 'required',
})
await view.settle([]) // 交回这一步真实执行的效果回执
const modelView = await view.build({ maxChars: 12_000 })
if (!(await view.validate(modelView))) console.warn('来源已变或授权撤回，重新 build')

const result = await view.complete()
if (!result.completed) console.warn(result.reason, result.recovery)
await view.end()
```

宿主可在验收前固定本次必需交付范围，逐项核查仍接入真实领域判据：

```ts
import type { ContextCompletionPort, ContextViewApi } from '@velaros-ai/context'

declare const view: ContextViewApi
// 调用第三参数的 checks.check，核查当前产物并取得覆盖全部产物的 current 证明。
declare const verifyDeliveredArtifacts: ContextCompletionPort['verify']

const completion: ContextCompletionPort = {
  requirements: (current) => [
    { id: 'implementation', label: '实现与边界行为', artifacts: ['src/index.ts'], sourceRefs: [current.goals[0].record.ref] },
    { id: 'example', label: '可运行示例', artifacts: ['examples/demo.ts'], sourceRefs: [current.goals[0].record.ref] },
  ],
  verify: verifyDeliveredArtifacts,
}
const result = await view.complete(completion)
console.log(result.completed, result.verified, result.report?.checks)
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/context` | 任何进程 | 会话上下文 `createContextRuntime`、任务与证据视图 `createContextView`、调用日志 `createContextInvocationJournal`、来源访问 `createEvidenceAccess`、活动差量账本 `createTurnContextSessionLedgers` 与通知 `createTurnContextAppendHub`，以及存储端口与全部数据类型 |
| `@velaros-ai/context/contracts` | 任何进程 | 上限表（`ContextLimits`、`DefaultContextViewLimits`、`StoreLimits` 等）与可移植数据类型 |
| `@velaros-ai/context/node` | Node ≥ 22.13 | 本地 SQLite 存储 `localContextStorage` |

## 约定

- `ContextStorage` 是唯一事实，`ContextRuntime` 不缓存：同一会话可以开多个实例，`replace` 靠存储的 CAS 定胜负，输的一方抛 `CONTEXT_CONFLICT`，重新 `inspect` 后再提交（`append` 自己重试，不会冲突）。
- 引用只在所属会话里解析，跨会话抛 `SCOPE_MISMATCH`；正文缺失抛 `OBJECT_MISSING`，不拿空串顶替；`project` 超预算抛 `CONTEXT_BUDGET`，不隐式压缩，最新一条用户输入与工作集之后到达的新事件总会带上。
- 用户输入、工具结果这类事实只由宿主 `append`，模型经 `write` 只能写笔记与检查点；工作集提交从下一次模型请求起生效，原文从不删除。
- 当前用户输入的完整性按实际读取范围判断。正文受单页上限限制且已有摘要时，保留头尾摘录和标为模型解释的历史摘要；较大的调用方预算不等同于已读取完整正文，原文继续按引用分页召回。
- 超长用户输入按完整 Unicode 字符分块归档，分页位置仍使用 UTF-16 字符数；读回依据归档记录的实际长度定位，也兼容固定宽度的既有分块。
- 证据视图一个会话同时只有一个租约持有者（否则 `TASK_BUSY`），租约时长见 `DefaultContextViewLimits.leaseMs`，长等待期间 `renew`。宿主休眠使租约到期时，原所有者仍须在同一存储 CAS 中验证身份后续期；检查点更新可在同次提交续期，世界写入前先保证租约有效并重验执行身份。接管竞争由 CAS 决定，被替换、撤销或已结束的所有权不能续期；效果不明的操作照实留在结算事实里，不挡下一步也不挡交付。上次执行中断时 `begin` 抛 `TASK_INTERRUPTED`。跨进程恢复先用 `acquireRecovery()` 在同一 CAS 中取得独占租约，再核对持久回执、用 `recover` 合入结算事实，最后调用返回的释放函数；恢复期间其他调用方不能接管或结算。SQLite 本地适配器登记进程所有者，同一宿主能证明进程已经退出时可立即恢复；其他宿主、PID 重用和权限不足保持租约保护，未提供存活能力的适配器沿用到期机制。本地适配器的进程证明只适用于本机数据库。
- `build` 只从 `ContextSourcePort` 真实读取，发布前核对版本与授权（不过抛 `STALE_VIEW`）；发送前还要 `validate`；没给 `ContextCompletionPort` 时 `complete` 的结果始终是未验证。
- 领域验收器通过 `requirements(view, signal)` 同步或异步声明必需项的 id、label、全部预期产物身份 `artifacts`，以及当前任务原始用户要求的 `sourceRefs`。异步提取受当前取消信号约束。Runtime 在调用 `verify` 前复制清单并核对原始引用；每项必须由 `checks.check` 签发的同 id、passed、complete 且 current 的证明覆盖全部产物，最终发布时再次探测。证明中的结果、范围、证据和产物不得扩写；报告在 `requirement` 中保留原始清单，供 Desktop 和审计端读取。范围与领域判据仍由宿主提供；没有领域验收器时保留未验证交付。
- 领域验收器可返回有界 `report`，逐项声明核查范围、时间、通过/失败/未知、证据引用与实际产物版本；`ContextVerificationLimits` 规定上限。报告归档后由 `readCompletion()` 读取当前任务的最近 `ContextCompletionRecord`，`readCompletion(ref)` 按 `inspect().completionRef` 等引用回看历史报告；失败报告也保留原任务与宿主对象身份，不把模型的完成主张当作核查。产物变化后旧报告保持原时刻的事实。
- 宿主验收器可使用 `verify(view, signal, checks)` 的可选第三参数，按 `checks.check(spec, execute)` 复用完整通过的单项检查。`spec` 声明精确判据范围、核查器身份/版本，并原子探测完整产物指纹、授权与能识别 ABA 的变化代次；前后匹配才复用。未知探测仍实际核查，失败或部分覆盖不缓存。缓存属于当前视图实例，重开需实际核查；旧两参数验收器保持可用。
- `completionApplicability(ref)` 重新使用已登记的可信探测解释原报告，返回 current、historical 或 unknown；这会产生真实探测，历史 passed 不能替代当前判断。核查与适用性探测的开始、结算和迟到费用归档到原任务，收费身份跨尝试去重；零费用需明确报告完整空清单，未知费用保留覆盖缺口。复用保留原 `checkedAt`、`proofRef` 和 `reusedFrom`。
- 验收器报告成功时，完成发布前再次探测报告中由 helper 签发的 current 证明；后续构建使产物变化或探测失去覆盖时，该项成为 unknown，返回 `VERIFICATION_ARTIFACT_CHANGED` 并要求补验。原单项检查和费用仍保留，最终探测独立记账；宿主继续负责完整依赖范围、原子探测及发布期间的写入协调。
- `complete(verifier, signal, commit)` 的可选宿主提交口只准备同一存储版本上的不可变记录。领域验收通过后，任务完成、报告和这些记录在同次 CAS 发布；竞争只重新准备记录，不重跑验收或外部操作。取消、验收失败或宿主对象变更均不提前发布完成记录。
- 独立使用时存储由宿主创建与 `close()`；交给 `createRuntime({ storage })` 并创建成功后由 Runtime 关闭；`close()` 幂等，只释放连接与等待，不删数据。
- `localContextStorage` 在创建时才加载 `node:sqlite`；注入别的 `ContextStorage` 的进程不需要 SQLite。
- 自己实现存储时要保证跨实例 CAS、正文先落盘、调用回执幂等、对象与附带消息原子提交；需要共享对象与消息时同时实现 `stores: StoreStorage`，共享对象不随会话回收。完整规范见 [存储适配规范](../../docs/architecture/storage.md)。
