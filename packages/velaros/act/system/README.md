# @velaros-ai/velaros/act/system

模型的自管理系统包 `velaros:system`：`modules`（发现能力、读合同与用法模板）、`goal`（主会话的目标）、`memory`（任务笔记、计划与材料驻留，装了长期记忆时还有 `recall`、`save`、`remove`）、`store`（跨会话的持久空间与消息）。`createRuntime` 按会话装好它；宿主经运行时配置记忆作用域与空间授权，经会话读写目标与笔记。

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
- 模型写 `import { modules, goal, memory, store } from 'velaros:system'`；同一会话每个成员只挂一种投影，按装配与授权取第一个可用的，实际操作与可用条件见 [Act 能力目录](../README.md)。
- `memory(sessionId)` 在主会话打开时固定作用域，模型选不了；搜索、整理与子任务不带长期记忆，要用由主线召回后显式交给它们。`release` 只释放当前任务里的展示、原文仍可召回，`remove` 才删长期记忆的原文。
- 不给 `stores` 时主会话在 `session:<id>` 的边界里建自己的空间，返回 `undefined` 就不挂 store；子任务只拿父任务经 `agents.start` 显式交出的权限子集，没有创建权，续跑时重新核对。
- 目标只在主会话：宿主的 `getGoal`、`updateGoal`、`controlGoal` 与模型的 `goal` 共用一份按版本追加的账本，版本不对抛 `GOAL_CONFLICT`、不合法的状态变化抛 `GOAL_INPUT`；删除只留 `removed` 墓碑，暂停的目标不会因新消息恢复，完成回复也不会自动完成活动目标。
- 笔记是模型的解释，不能覆盖真实回执；宿主经会话的 `listNotes`、`readNote`、`setNoteResident` 看和调驻留，与模型共用版本，移出上下文不删正文。
- `memory.organize` 只排队：下一次模型请求之前由整理模型按父快照交补丁，补丁先整份校验再按版本发布，失败的不发布、原因带到下一帧；整理只改展示，不重跑业务脚本。`context: { maintenance: false }` 关掉整理。
