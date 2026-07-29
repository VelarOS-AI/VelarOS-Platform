# @velaros-ai/computer 接口总览

本包是**一个安装单元、两个导入切片**。切片的完整接口文档原样保留在 `docs/<slice>/api.zh-CN.md`:

| 切片 | 子路径 | 详细文档 |
| --- | --- | --- |
| runtime | `@velaros-ai/computer/runtime` | [runtime/api.zh-CN.md](./runtime/api.zh-CN.md) |
| tools | `@velaros-ai/computer/tools` | [tools/api.zh-CN.md](./tools/api.zh-CN.md) |

## 定位与非目标

定位:计算机控制能力的唯一家——OS 级 sidecar 运行时(进程管理 + JSON-lines 协议)与 Agent 工具集合。

非目标:**不提供根导出**。只装配 sidecar 的宿主不该被迫吃进工具集合的 zod schema 面;
本包也不拥有产品 IPC、不做权限决策(权限门在宿主),不依赖 Agent 运行时。

## 安装

```bash
bun add @velaros-ai/computer
```

## 公共入口

- `@velaros-ai/computer/runtime` — 见 [runtime/api.zh-CN.md](./runtime/api.zh-CN.md)
- `@velaros-ai/computer/tools` — 见 [tools/api.zh-CN.md](./tools/api.zh-CN.md)

## 核心类与接口

见各切片文档;合并未改动任何导出符号(切片根导出与合并前两个包的根导出逐字节等价)。

## 生命周期/并发

sidecar 进程的启动/健康检查/回收语义原样;见 runtime 切片文档。

## 依赖注入

tools 切片对 runtime 切片的依赖合并后走**包内相对 import**,对外注入面(ComputerToolContext 等)不变。

## 错误模型

统一走 `@velaros-ai/core/error` 的结果/错误约定;sidecar 协议错误见 runtime 切片文档。

## 最小第三方示例

```ts
import { computerTools } from '@velaros-ai/computer/tools'
import { ComputerSidecarManager } from '@velaros-ai/computer/runtime'
```

## 扩展点

helper 解析器(`resolveHelper`)、资源根注入、工具集合裁剪;见各切片文档。

## 兼容策略

切片子路径即兼容面:`@velaros-ai/computer-{runtime,tools}` 的根导出分别等价于
`@velaros-ai/computer/{runtime,tools}`。版本随平台单版本火车推进。
