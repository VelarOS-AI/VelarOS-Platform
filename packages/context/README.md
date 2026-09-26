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
- 证据视图一个会话同时只有一个租约持有者（否则 `TASK_BUSY`），租约时长见 `DefaultContextViewLimits.leaseMs`，长等待期间 `renew`；效果不明的操作照实留在结算事实里，不挡下一步也不挡交付。上次执行中断时 `begin` 抛 `TASK_INTERRUPTED`，先把按持久日志收拾出的事实用 `recover` 合入。
- `build` 只从 `ContextSourcePort` 真实读取，发布前核对版本与授权（不过抛 `STALE_VIEW`）；发送前还要 `validate`；没给 `ContextCompletionPort` 时 `complete` 的结果始终是未验证。
- 独立使用时存储由宿主创建与 `close()`；交给 `createRuntime({ storage })` 并创建成功后由 Runtime 关闭；`close()` 幂等，只释放连接与等待，不删数据。
- `localContextStorage` 在创建时才加载 `node:sqlite`；注入别的 `ContextStorage` 的进程不需要 SQLite。
- 自己实现存储时要保证跨实例 CAS、正文先落盘、调用回执幂等、对象与附带消息原子提交；需要共享对象与消息时同时实现 `stores: StoreStorage`，共享对象不随会话回收。完整规范见 [存储适配规范](../../docs/architecture/storage.md)。
