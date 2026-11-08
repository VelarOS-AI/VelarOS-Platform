# @velaros-ai/velaros/memory

跨会话的长期记忆：一个作用域一个目录的 Markdown，一条记忆一个 `<id>.md`。模型面是 `list`、`save`、`remove` 三个操作；宿主面是记忆库本身，按作用域取一份、排会话开场的索引、给管理页列作用域。作用域由产品给，记忆不解释它，只按它隔离。

## 用法

```ts
import { createRuntime } from '@velaros-ai/velaros'
import { createMemoryStore, memoryOperations, type MemoryOperationContext } from '@velaros-ai/velaros/memory'

// 根目录与作用域都由产品定：作用域是任意非空字符串，按字符串逐字隔离
declare const memoryRoot: string
declare function scopeOfSession(sessionId: string): string

const store = createMemoryStore({ root: memoryRoot })
const scope = store.scope('project:/srv/site')

// 宿主自己调用（管理页、测试）
const context: MemoryOperationContext = { abortSignal: new AbortController().signal, memory: scope }
const { created } = await memoryOperations.save(
  { id: 'release-flow', type: 'work', title: '发布流程', description: '先跑 check 再打 tag', content: '……' },
  context
)
if (!created) console.log('覆盖了已有的 release-flow')
for (const entry of await memoryOperations.list(context)) console.log(entry.id, entry.title, entry.updatedAt)
const opening = await scope.renderIndex() // 可选索引：是否放进提示词由宿主决定
const scopes = await store.listScopes() // 管理页：有记忆的作用域、条数、最近更新

// 宿主有自己的删除写屏障时，先同步核对 Platform 的删除输入，再进入屏障调用 scope.remove
const removal = store.prepareRemove({ id: 'release-flow' })
// 在宿主写屏障内：await scope.remove(removal)

// 接进 Act 运行时：每个主会话固定一个作用域，模型经 velaros:system 的 memory 读写
declare const dataDir: string
export const runtime = await createRuntime({ dataDir, memory: (sessionId) => store.scope(scopeOfSession(sessionId)) })
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/memory` | Node | `memoryOperations`、记忆库 `createMemoryStore`、作用域端口与调用上下文 |
| `@velaros-ai/velaros/memory/contracts` | 任何进程 | 类别 `MemoryTypes`、上限 `MemoryLimits`、入参与回执、作用域概况 `MemoryScopeSummary`、模型面 `VelarMemoryModule` |

## 约定

- 根目录要是绝对路径、作用域要非空，否则 `VALIDATION`；目录第一次写入时才建，每次调用都从磁盘现读，进程里不留状态，没有要关闭的东西。
- `save` 同一个 id 整条覆盖，只有没给的 `tags` 沿用原来的；`remove` 真删文件，本来就没有时 `removed` 为假，不算错。
- 入参超出 `MemoryLimits` 或类别不在 `MemoryTypes` 里抛 `VALIDATION`，一个文件都不写、不删；磁盘本身的错（权限、磁盘满）原样抛出。
- `store.prepareRemove(input)` 与 `scope.remove(input)` 复用同一份删除输入规范，返回只含 `id` 和可选 `expectedRevision` 的独立快照。它同步校验 id、Windows 保留名和版本格式，不读磁盘、不核对当前 revision、不承诺删除已提交；宿主可先校验再进入自己的写屏障，`remove` 仍会核对输入并在锁内做 CAS。
- 只读写当前五字段头部：按 `title`、`description`、`type`、`tags`、`updated` 的顺序，`---` 包围，空一行后是正文。标题和描述是 JSON 字符串，标签是 JSON 字符串数组，类别必须是 `MemoryTypes` 的精确值，时间是完整 ISO 字符串。合法标签中的方括号、单双引号和非 ASCII 字符保留，只做 trim、转小写、去重；BOM 与 CRLF 可读，revision 始终基于原始文件内容。旧别名、缺失或未知字段、未知类别、损坏头部报 `VALIDATION`，不自动迁移、不静默跳过，`save` 也不会覆盖无效原件。
- 没有检索层，运行时也不替你调 `renderIndex()`：宿主可按需渲染索引并决定是否放进提示词；放不下的只报条数，模型要正文就 `list()` 自己筛。
- `createRuntime` 不许业务模块占用 `velaros:memory`（`VALIDATION`），长期记忆只走它的 `memory` 选项；`VelarMemoryModule` 留给不经 Act 运行时、直接用代码面或 Kernel 的宿主。

并发修改时，`list`/`save` 的 `revision` 可作为 `save`/`remove` 的 `expectedRevision`；`null` 表示要求目标不存在，过期或同条目写锁冲突报 `CONFLICT`。省略版本时按最后提交者覆盖正文，未提供的标签沿用锁内最新标签。写锁按磁盘条目协调遵守该协议的进程；外部直接编辑器不参与锁。取消在提交前生效，原子提交开始后保留实际结果。
