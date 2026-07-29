# `@velaros-ai/core` 中文接口文档

## 定位与非目标

本包提供可被任意 Node.js/浏览器应用复用的基础契约、错误、结果、日志、聊天流协议和纯工具函数。它不包含产品 DTO、Electron IPC、具体能力实现、模块编排或 UI。

## 安装

```bash
npm install @velaros-ai/core
```

包为 ESM，要求 Node.js 20 或更高版本。根入口可在通用运行时使用；文件持久化等 Node 专用工具仅从相应子路径按需导入。

从 `0.3.2` 起，发布声明不再携带 ambient 全局类型；`Nullable`、
`LooseOptional` 等源码辅助别名会被构建为包内私有模块类型，不会污染消费者的
全局声明空间。

## 公共入口

- `@velaros-ai/core`
- `@velaros-ai/core/assert`
- `@velaros-ai/core/error`
- `@velaros-ai/core/result`
- `@velaros-ai/core/logger`
- `@velaros-ai/core/types`
- `@velaros-ai/core/tool-contract`
- `@velaros-ai/core/chat-stream`
- `@velaros-ai/core/cli`
- `@velaros-ai/core/constants/*`、`@velaros-ai/core/types/*`、`@velaros-ai/core/utils/*`

## 核心类与接口

- `AppError`：带稳定代码和结构化上下文的应用错误。
- `LogRuntime`、`Logger`：可注入 transport 的实例化日志系统。
- `TimerScope`：统一持有、取消和释放计时器。
- `ChatStreamProtocol`、`ChatStreamConsumer`、`ChatStreamSessionLog`：流式聊天帧及消费状态。
- `TypeGuards`：可当值传递的运行时守卫集合；守卫也支持具名导入。
- `ToolDescription`、tool-contract schema：工具描述与调用契约。

## 生命周期/并发

纯函数和 schema 无共享状态。`LogRuntime`、`TimerScope` 和聊天流类由调用方按应用或请求创建；使用完成后调用 `dispose`/`flush`。原子文件写入使用随机临时文件名，不依赖进程级计数器，可安全并发调用。

## 依赖注入

日志 transport、计时器 host、持久化路径和聊天流回调通过构造参数注入。包入口不修改 `globalThis` 或内建原型。第三方应用无需采用 VelarOS 的日志、IPC 或配置系统。

## 错误模型

可预期业务失败用 `Result` 或 `AppError` 表达；断言只用于编程不变量。解析外部值时优先使用 schema/守卫，边界处规范化一次，内部不要反复在多个 DTO 间转换。

## 最小第三方示例

```ts
import { AppError, isPresent } from '@velaros-ai/core'
import { LogRuntime, createMemoryTransport } from '@velaros-ai/core/logger'

const log = new LogRuntime({ appName: 'acme-cli', consoleEnabled: false })
const memory = createMemoryTransport({ id: 'test-memory' })
log.addTransport(memory)

function requireValue<T>(value: T | null | undefined): T {
  if (!isPresent(value)) throw new AppError('INVALID_INPUT', 'value is required')
  return value
}

log.tag('bootstrap').info('ready', requireValue('ok'))
await log.flush()
```

## 扩展点

实现 `LogTransport` 可接入任意日志后端；tool-contract 和 chat-stream 类型可用于实现自己的传输层。只被单一能力使用的契约应放在能力包，不应继续扩大 Core。

## 兼容策略

公共 `exports`、错误码和序列化契约遵循 SemVer。通配子路径仍只承诺已导出的文件，不承诺 `dist` 目录结构。旧别名仅在有实际消费者时保留，并在移除前标记弃用。
