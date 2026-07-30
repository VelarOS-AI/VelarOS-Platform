# @velaros-ai/game 接口

## 定位与非目标

本包承载 VelarOS 游戏能力域。`core` 只表达渲染器无关的游戏工程与场景事实；`runtime` 投影到
web 游戏运行时；`tools` 提供模型可调用的游戏语义工具；`composition` 是宿主唯一装配入口。
它不拥有 Desktop 壳、权限策略、凭据、云发布或商业核验。

## 安装

Platform 单版本火车内部使用 `workspace:*`。发布消费者按同一版本安装后，只导入所需 subpath；
没有根导出。

## 公共入口

- `@velaros-ai/game/core`：工程布局、schema 与运行时端口。
- `@velaros-ai/game/runtime`：Phaser 投影、运行态与 dev server 适配。
- `@velaros-ai/game/tools`：`game_*` 工具名、schema 与工具集合。
- `@velaros-ai/game/composition`：把前三个分区装配成宿主可注入能力。

## 核心类与接口

- `core`：project/scene/prefab/assets schema、宽容文本解析、canonical formatter、
  `GameManifestResolver`、`GameManifestWorkspaceEditor` 与 renderer-neutral runtime ports。运行态默认
  只在继承补丁合并后应用；`game.project.json` 的 `prefabs` 是 prefab 进入编辑、校验和运行拓扑的
  唯一显式清单。磁盘上未声明的预放文件惰性留在拓扑外，坏草稿不阻塞无关编辑；路径加入
  `project.prefabs` 的同一批编辑才解析并校验。resolver 会校验已声明但尚未实例化的 prefab、
  资产类型、稳定 id 唯一性和 parent 环。V0 的 `parent` 表达稳定关系与引用完整性，transform
  仍使用世界坐标；层级 transform 投影留待后续版本。
- `runtime`：`createPhaserGameRuntime`、`GameDevServerController`、`GameProjectRuntime`，
  以及宿主实现的 `GameApprovedProcessHost` / `GameRuntimePageHost`。Phaser follow camera 按
  `camera.target` 引用目标实体，不把声明 camera 组件的实体误当目标。dev server 只接受
  `readyText` 纯文本或自动发现的 loopback URL，不执行工程提供的就绪正则。
- `tools`：稳定六工具 `GameToolNames`、输入 schema、能力声明和 `gameTools`。
- `composition`：`createGameCapability`（默认不可用）、`createGameProjectCapability` /
  `createGameProjectCapabilityFromText` 与 `createGameManifestEditor`。

## 生命周期/并发

`core` 与工具描述符是不可变值。运行时实例由 composition 创建并归调用宿主持有；dev server、
浏览器目标和运行态缓存不得落成进程全局单例。停止与 dispose 必须幂等。语义编辑若修改
`game.project.json`，composition 会在同一能力实例内刷新运行时工程快照；正在运行的实例在下一次
`game_run` 强制重启，不能继续复用旧命令、端口或入口场景。

## 依赖注入

运行时的进程执行、权限申请、页面驱动、截图与输入能力由宿主端口注入。工具只依赖 `core` 契约和
注入端口，不直接 import Desktop、Electron 或 Agent runtime。宿主未注入端口时
`createGameCapability()` 的 editor/runtime 都不可用；不会自动 spawn、打开页面或推断权限。

## 错误模型

输入错误、权限拒绝、编译失败与运行时失败使用结构化结果区分。权限策略缺席时默认 deny；
截断与幂等完成态不归为工具失败。V0 不提供 `game_assert`；调用方基于 `game_query_state`
结构化结果判断，避免复制查询语义。

## 最小第三方示例

```ts
import { createGameCapabilityDescriptor } from '@velaros-ai/game/composition'

const descriptor = createGameCapabilityDescriptor()
console.info(descriptor.id, descriptor.runtime.backend)
```

宿主装配一个真实工程时，必须同时提供受限文档存储、获批进程端口和受控页面端口：

```ts
import { createGameProjectCapabilityFromText } from '@velaros-ai/game/composition'

const capability = createGameProjectCapabilityFromText({
  projectRoot,
  projectText,
  documents,
  processHost,
  pageHost,
})

const toolContext = capability.createToolContext(abortSignal)
```

## 扩展点

扩展通过 `core` 的窄端口、runtime backend 投影和 composition 注入完成。场景 schema 不接受
Phaser 专属词汇；页面级截图与受控求值复用宿主 BrowserRuntime 端口，但 game 页面身份必须由
game/project session 持有，不借用 browser 工作区当前站点。

## 兼容策略

包随 Platform 单版本火车发布。正常加字段保持 optional、宽容读取并回显调整；
不可归一化的整体重写才允许变更 schema channel。四个 subpath 的职责边界不通过兼容层复制。
