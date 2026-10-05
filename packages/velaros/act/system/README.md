# @velaros-ai/velaros/act/system

模型的自管理系统包 `velaros:system`：`modules` 发现能力与定向合同，`programs` 发布和发现参数化程序，`goal` 管目标，`memory` 管笔记与材料，`store` 管共享状态。`createRuntime` 按会话装配；宿主固定记忆、空间、程序与来源权限。

## 用法

```ts
import { createRuntime } from '@velaros-ai/velaros'
import type { ModelDriver } from '@velaros-ai/model'
import { systemModules, type StoreConfiguration } from '@velaros-ai/velaros/act/system'
import { createMemoryStore } from '@velaros-ai/velaros/memory'

// 宿主给：模型、状态目录（绝对路径）、当前用户，以及别人建好并授权给他的空间
declare const model: ModelDriver
declare const stateDir: string
declare const userId: string
declare const teamStore: string

// 长期记忆一个作用域一个目录，作用域由产品定（这里按用户）
const memories = createMemoryStore({ root: `${stateDir}/memory` })

const runtime = await createRuntime({
  dataDir: stateDir,
  model,
  // 主会话打开时固定作用域，模型经 memory.recall、save、remove 用它
  memory: () => memories.scope(`user:${userId}`),
  // 主会话的持久空间：边界、能不能新建、授权过来的空间与键前缀
  stores: (): StoreConfiguration => ({
    scope: `user:${userId}`,
    create: true,
    grants: [{ store: teamStore, read: ['shared/'], write: [] }],
  }),
})

// 宿主界面只列业务能力：velaros:system 的成员不单独列
const business = runtime.modules().items.filter((card) => !systemModules.owns(card.binding.moduleId))
console.log(business.map((card) => card.binding.moduleId))

// 用户在界面上暂停目标：和模型的 goal.update 共用一份账本，按版本改
const session = await runtime.openSession('main')
const goal = await session.getGoal()
if (goal?.status === 'active') await session.controlGoal({ baseRevision: goal.revision, action: 'pause' })
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/act/system` | Node | 系统成员的装配 `systemModules`（及单项的 `memoryModule`、`modulesModule`、`storeModule`）、它们要的宿主端口，目标、笔记、记忆、空间与模块目录的数据 |

## 约定

- 宿主一般不直接装：`createRuntime` 按会话挂好这些成员，业务模块不能占用它们的身份；单项装配只给自己拼 Kernel 的宿主用，状态都按调用会话从宿主端口现取。
- `modules.list` 的真实 `exports` 可直接作为查询名称；`contentRevision` 标识声明与模板正文。`describe({module,exports:['read','edit']})` 同次交回去重的类型闭包与模块共同规则；指定导出默认只给声明，需要整模块示例传 `template:true`。未指定导出保留完整合同。查询与版本号不授予权限，也不代表模型已看到正文。
- `programs.publish` 检查并归档完整源码与附属模块，不执行；新名称的 `baseRevision` 为 0，更新同名程序带当前名称版本。目录交回不可变 `sourceRef`、源码 `contentRevision` 和发布时依赖身份；后续按正常 `execute({sourceRef,input,blobs})` 复用，每次仍核对当前权限、模式与真实回执。名称、用途和参数说明是作者数据；查询先按授权及任务重置边界过滤，旧版本不会替代当前名称，也不恢复已失效的来源权限。
- 模型写 `import { modules, goal, memory, store } from 'velaros:system'`；同一会话每个成员只挂一种投影，按装配与授权取第一个可用的，实际操作与可用条件见 [Act 能力目录](../README.md)。
- `memory(sessionId)` 在主会话打开时固定作用域，模型选不了；搜索、整理与子任务不带长期记忆，要用由主线召回后显式交给它们。`release` 只释放当前任务里的展示、原文仍可召回，`remove` 才删长期记忆的原文。
- 不给 `stores` 时主会话在 `session:<id>` 的边界里建自己的空间，返回 `undefined` 就不挂 store；子任务只拿父任务经 `agents.start` 显式交出的权限子集，没有创建权，续跑时重新核对。
- 目标只在主会话：宿主的 `getGoal`、`updateGoal`、`controlGoal` 与模型的 `goal` 共用一份按版本追加的账本，版本不对抛 `GOAL_CONFLICT`、不合法的状态变化抛 `GOAL_INPUT`；删除只留 `removed` 墓碑，暂停的目标不会因新消息恢复，完成回复也不会自动完成活动目标。
- 笔记是模型的解释，不能覆盖真实回执；宿主经会话的 `listNotes`、`readNote`、`setNoteResident` 看和调驻留，与模型共用版本，移出上下文不删正文。
- 执行结果支持按实际曝光轮数、当前上下文段（`segment`）或当前任务（`task`）保留；`memory.retain` 默认任务期限，`release` 立即释放展示。段期限随该结果封入历史卷时退役，原文仍可读取，续租与封段不重跑原脚本。
- `memory.organize` 只排队：下一次模型请求之前由整理模型按父快照交补丁，补丁先整份校验再按版本发布，失败的不发布、原因带到下一帧；整理只改展示，不重跑业务脚本。`context: { maintenance: false }` 关掉整理。
- 整理首帧提供用户输入与近期原文，保留真实引用、范围和补读位置；模型按需要读取已有引用，查更早材料时再分页列目录。输入分页按已接受请求的真实送达范围推进，父任务的压缩目标不限制整理器读取原文。
- 整理目录与工作记忆共用材料分类，按可见的输入、回复、源码、结果、笔记与历史卷计页；游标指向页末真实序号。授权重置后，仅当前材料和用户明确重新附上的旧材料可被发现。卷叙事校验一次列出全部越界引用，修正前整份补丁不发布。

- `memory.read` 可传展示中的执行结果字段 `pointer`，按该字段的 UTF-16 字符分页；字符串直接返回正文，其他值返回 JSON。响应携带相同 `pointer`，`record` 仍标识完整归档。路径、页长和引用权限均受校验；省略路径时保持整份归档读取，旧宿主收到字段读取会明确报告不支持。

执行结果的必需块缺口带有 `runtime.decision.missing[].read` 整块入口。将它传给 `memory.read`，从 `offset: 0` 开始，每页原样 `output(page, {key: 唯一键, view: {mode: 'full'}})`，再按 `page.offset + page.text.length` 续页。`delivery.receipt` 是宿主绑定原文身份、版本及字符范围的回执；只有本次模型请求实际完整携带的页连续覆盖整块，才满足原块的 `required`。省略 pointer 时可分页交付整份结果归档；两种表示的范围分开核对。

可以在同一段 execute 中输出多页，展示预算仍按原合同分配。仅调用 read、只输出 page.text、把 page 嵌套到其他对象、改写页对象、召回局部字段、页再次截断或所需页已退出当前历史，都不产生完整交付证明。初始摘录不参与分页覆盖，释放仍需显式 release。

脚本失败后，`runtime.progress.feedback.recovery.index` 给出该结果的调用索引入口。先 `memory.read(index)`，按索引的 `id` 调用 `memory.read({ref: index.ref, invocation: id})`，即可在同一次 execute 中收集已落定的原始调用回执；大索引与回执均按 offset/limit 分页。`pointer` 此时相对回执根，含 `outcome`、`effect`、`value`、`error`，失败或未知状态保持原样。调用召回不会重新执行，不签发必需输出块的 delivery；未落定回执返回明确不可用。release 和封段不删除召回权，任务授权重置及跨会话限制沿用原文规则。
