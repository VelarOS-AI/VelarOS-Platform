# @velaros-ai/game

**VelarOS 游戏能力域的单发布包**(capabilities 域,住 `packages/game`,域归属由仓根
`velaros.domainPackages` 声明)。它把「AI 写游戏」这件事拆成声明式工程事实、
web 运行时投影、模型可调用的工具、浏览器安全契约与宿主装配入口——**各层占独立 subpath,刻意不给根导出**,
因为它们的运行面互斥(浏览器侧只要 `core`,Node 宿主才要 `composition`)。

```
@velaros-ai/game/core         渲染器无关的工程/场景事实(schema + 解析 + 解析器 + 端口)
@velaros-ai/game/runtime      web 运行时投影(Phaser 4)+ dev server + 内置静态服务 + 运行态
@velaros-ai/game/tools        六个 game:* 工具的名字、schema 与集合
@velaros-ai/game/contracts    renderer-safe 的工具、空间、Mod 与上下文源身份
@velaros-ai/game/composition  宿主能力装配入口
@velaros-ai/game/composition/mod           Mod Loader 定义
@velaros-ai/game/composition/turn-context  宿主回合上下文协调器
```

## 它解决什么问题

游戏工程的**事实**用 JSON 声明(`game.project.json` / 场景 / prefab / 资产清单),
模型编辑的是这些声明而不是渲染器 API。`core` 是这套声明的唯一权威,
`runtime` 负责把它投影到具体渲染器上。**换渲染器不该改场景 schema**——
所以 `core` 的词汇表里没有任何 Phaser 专属概念,scene schema 也不接受它们。
当前唯一 backend 是 `phaser4`(`GameRuntimeBackend`),3D 留待后续。

## 分区职责

### `core` —— 声明式事实层

工程布局常量(`GameProjectFileName` = `game.project.json`、
`GameProjectDirectories` = `assets` / `prefabs` / `scenes` / `src`)、四份 zod schema
(project / scene / prefab / assets)、宽容文本解析(`parseGameProjectManifestText`,
基于 `@velaros-ai/core` 的 ForgivingSchema,归一化后回显 `AppliedAdjustment`)、
canonical formatter、`GameManifestResolver`、`GameManifestProjectEditor`,
以及渲染器无关的运行时端口 `GameRuntimePort` / `GameSceneEditorPort`。

两条容易被忽略的设计:

- **`game.project.json` 的 `prefabs` 是 prefab 进入拓扑的唯一显式清单。**
  磁盘上未声明的预放文件惰性留在拓扑外——坏草稿不会阻塞无关编辑;
  路径被加进 `project.prefabs` 的那一批编辑才解析并校验它。
- **V0 的 `parent` 只表达稳定关系与引用完整性**,transform 仍是世界坐标;
  层级 transform 投影留待后续版本。resolver 会校验已声明未实例化的 prefab、
  资产类型、稳定 id 唯一性和 parent 环。

### `runtime` —— web 投影层

`createPhaserGameRuntime`(把 resolved scene 投影成 Phaser 对象树)、
`GameDevServerController`、`GameProjectRuntime`、`GameRuntimeDiagnostics`。
它**自己不 spawn 进程、不开页面**:进程执行走宿主注入的 `GameApprovedProcessHost`
(缺席时是 `DenyAllGameProcessHost`,直接抛 `GameRuntimePermissionDeniedError`),
页面驱动 / 截图 / 输入走宿主注入的 `GameRuntimePageHost`。

两条安全约定:dev server 只接受 `readyText` 纯文本或自动发现的 loopback URL,
**不执行工程提供的就绪正则**;Phaser follow camera 按 `camera.target` 引用目标实体,
不把「声明了 camera 组件的实体」误当目标。

**`dev.server.command` 缺席时走 `GameBuiltinDevServer`**(2026-08-01 判决):宿主在自己进程里
起一份绑 loopback、用临时端口的静态服务,把「自带运行时的页面 + 已解析好的清单」送出去,
于是**工程只出清单也能跑起来**——不需要 `package.json`、不需要装依赖、不需要联网。
运行时字节由宿主经 `pageScript` 注入(构建产物 `dist/browser/page-source.js`,
入口源码 `src/runtime/browser-entry.ts`,单独 `bun build --target=browser` 成包);
文件只回送**上一次 boot 按清单声明过的**资产与玩法脚本,路径逐字查表、不做 join,
`Host` 头必须是本机。声明了 `command` 的工程照旧走进程那条路——内置服务是缺省,不是唯一。

### `tools` —— 模型面

稳定六工具(`GameToolNames`,顺序即注册顺序):

| 工具 | 干什么 |
| --- | --- |
| `game:scene_edit` | 语义编辑场景 / prefab / 工程声明 |
| `game:run` | 启动运行态(缺省 = 宿主内置静态服务;工程声明了 `dev.server.command` 则起它)并打开入口场景 |
| `game:stop` | 停止运行态(幂等) |
| `game:screenshot` | 截当前画面(可带区域与 overlay) |
| `game:query_state` | 查 scene / selection / entities / entity / errors / perf |
| `game:input` | 注入 press / key_down / key_up / tap / move / wait 序列 |

**V0 刻意不提供 `game:assert`**:断言语义会和 `game:query_state` 的查询语义重复一份,
调用方直接基于结构化结果判断。

### `composition` —— 宿主装配

`createGameCapability()`(**默认全不可用、fail closed**)、
`createGameProjectCapability()` / `createGameProjectCapabilityFromText()`、
`createGameManifestEditor()`。稳定身份从 `@velaros-ai/game/contracts` 读取；Mod 定义与回合上下文分别从
`@velaros-ai/game/composition/mod`、`@velaros-ai/game/composition/turn-context` 读取。
`GameModId` = `velaros.game`、`GameSpaceId` = `game`，`GameTurnContextCoordinator`
(三个回合上下文源:`game.runtime-errors` / `game.selection` / `game.scene-state`)。

包根的 `velaros.mod.json` 是这个 mod 的分节信封(module 节 + agent 节),
`trust: bundled-official`、`defaultEnabled: false`——**装了不等于开了**。

## 典型用法

只想知道能力身份(不需要任何宿主端口):

```ts
import { createGameCapabilityDescriptor } from '@velaros-ai/game/composition'

const descriptor = createGameCapabilityDescriptor()
console.info(descriptor.id, descriptor.runtime.backend) // 'game' 'phaser4'
```

装配一个真实工程——必须同时给受限文档存储、获批进程端口、受控页面端口:

```ts
import { createGameProjectCapabilityFromText } from '@velaros-ai/game/composition'

const capability = createGameProjectCapabilityFromText({
  projectRoot,
  projectText,   // game.project.json 原文
  documents,     // GameManifestDocumentStore:宿主限定在工程根内
  processHost,   // GameApprovedProcessHost:已过 process:exec 审批
  pageHost,      // GameRuntimePageHost:宿主的浏览器 / 页面控制
})

const toolContext = capability.createToolContext(abortSignal)
// capability.tools 即 gameTools,交给 agent 的工具注册面
```

语义编辑若改到 `game.project.json`,composition 会在同一能力实例内刷新运行时工程快照;
**正在跑的实例会在下一次 `game:run` 强制重启**,不复用旧命令、端口或入口场景。

## 边界:本包不负责什么

- 不拥有 Desktop 壳、权限**策略**、凭据、云发布或商业核验——只声明需要 `process:exec`,
  批不批由宿主定,缺席即 deny。
- 不 import Electron / Desktop / Agent runtime;工具只认 `core` 契约和注入端口。
- 不落进程全局单例:dev server、页面目标和运行态缓存都归调用宿主持有,
  `stop` 与 `dispose` 必须幂等。
- 页面级截图与受控求值复用宿主的 BrowserRuntime 端口,但**game 页面身份必须由
  game / project session 持有**,不借用 browser 工作区的当前站点。

## 相邻包

| 包 | 关系 |
| --- | --- |
| `@velaros-ai/core` | 唯一的仓内运行时依赖:ForgivingSchema、TurnContextLedger、`ToolCategoryDefinition` |
| `@velaros-ai/agent` | 消费方:把 `gameTools` 注册进工具面,把回合上下文源接进 turn context |
| `@velaros-ai/browser` | 不直接依赖;宿主可以用它实现 `GameRuntimePageHost` |

## 兼容策略

随 Platform 单版本火车发布。schema 正常演进的姿势是**加 optional 字段 + 宽容读取 + 回显调整**;
只有不可归一化的整体重写才允许动 `GameSchemaChannel`(现值 `v0`)。
四个 subpath 的职责边界不通过兼容层复制——需要跨分区的东西走 composition 注入。
