# @velaros-ai/browser 接口总览

本包是**一个安装单元、四个导入切片**。每个切片的完整接口文档原样保留在
`docs/<slice>/api.zh-CN.md`,本文只做总览与索引:

| 切片 | 子路径 | 详细文档 |
| --- | --- | --- |
| core | `@velaros-ai/browser/core`、`@velaros-ai/browser/core/contracts` | [core/api.zh-CN.md](./core/api.zh-CN.md) |
| tools | `@velaros-ai/browser/tools`、`@velaros-ai/browser/tools/cli` | [tools/api.zh-CN.md](./tools/api.zh-CN.md) |
| composition | `@velaros-ai/browser/composition` | [composition/api.zh-CN.md](./composition/api.zh-CN.md) |
| runtime | `@velaros-ai/browser/runtime` | [runtime/api.zh-CN.md](./runtime/api.zh-CN.md) |

## 定位与非目标

定位:浏览器能力的唯一家——CDP 自动化内核、Agent 工具集合、React 合成边界、Electron 会话运行时。

非目标:**不提供根导出**。四个切片的运行面互斥(host 无关 / React / Electron),合并成一个根入口
会让 renderer 侧 bundle 顺着根 index 拽进 Electron 代码——这正是必须靠子路径切分守住的墙。
本包也不注册产品 IPC、不拥有会话编排、不依赖 Agent 运行时。

## 安装

```bash
bun add @velaros-ai/browser
```

`react` 与 `electron` 都是**可选 peer**:只用 `./core` / `./tools` 的宿主两个都不需要装。

## 公共入口

- `@velaros-ai/browser/core` — 见 [core/api.zh-CN.md](./core/api.zh-CN.md)
- `@velaros-ai/browser/core/contracts` — 浏览器安全 DTO 与纯策略(无 Node 内置模块)
- `@velaros-ai/browser/tools` / `@velaros-ai/browser/tools/cli` — 见 [tools/api.zh-CN.md](./tools/api.zh-CN.md)
- `@velaros-ai/browser/composition` — 见 [composition/api.zh-CN.md](./composition/api.zh-CN.md)
- `@velaros-ai/browser/runtime` — 见 [runtime/api.zh-CN.md](./runtime/api.zh-CN.md)

## 核心类与接口

各切片的类/接口清单在切片文档内,合并未改动任何导出符号:切片根导出与合并前的四个包根导出
逐字节等价。

## 生命周期/并发

见各切片文档;合并不改变任何生命周期语义(会话队列、pending events broker、driver 内核均原样)。

## 依赖注入

见各切片文档。跨切片依赖(tools/composition/runtime → core)合并后走**包内相对 import**,
不再经由包说明符;对外注入面不变。

## 错误模型

见各切片文档,统一走 `@velaros-ai/core/error` 的结果/错误约定。

## 最小第三方示例

```ts
import { CdpBrowserRuntime } from '@velaros-ai/browser/core'
import { browserTools } from '@velaros-ai/browser/tools'
```

Electron 宿主再叠加 `@velaros-ai/browser/runtime`;renderer 只取 `@velaros-ai/browser/core/contracts`。

## 扩展点

见各切片文档(driver / launcher / 工具集合 / 合成 Provider)。

## 兼容策略

切片子路径即兼容面:`@velaros-ai/browser-{core,tools,composition,runtime}` 的根导出分别等价于
`@velaros-ai/browser/{core,tools,composition,runtime}`。版本随平台单版本火车推进。
