# @velaros-ai/core

VelarOS 各包与宿主共用的无领域语义底层：统一错误、断言、`Result`、日志、类型守卫与通用小工具，都在 `src/` 下；另有三个底层单元（跨平台约定、磁盘文本、路径规则）住在 `src/<单元>/`，各有自己的说明。

## 用法

```ts
import { isPresent, Log, Result } from '@velaros-ai/core'
import { AppError, createAbortError } from '@velaros-ai/core/error'
import { createKeyedSerialQueue } from '@velaros-ai/core/utils/KeyedSerialQueue'

const log = Log.tag('Settings')

// 产品代码里的错都从 AppError 造：错误码加一句话，不直接 new Error（check:error-construction 核对）
export function readPort(value: unknown): number {
  const port = Number(value)
  if (!isPresent(value) || !Number.isInteger(port)) throw new AppError('VALIDATION', `端口不合法：${String(value)}`)
  return port
}

// 调用方要读的字段挂在错误顶层：catch 里直接读 error.currentRevision
export function assertRevision(expected: number, current: number): void {
  if (expected !== current)
    throw AppError.withFields('CONFLICT', '设置已被别处改过，重新读取后再改', { currentRevision: current })
}

// catch 到的未知值：已经是 AppError 的原样返回，别的包成这个码，原错误挂在 cause
export async function loadPort(fetchSetting: () => Promise<unknown>): Promise<number> {
  try {
    return readPort(await fetchSetting())
  } catch (error) {
    throw AppError.from(error, 'NETWORK')
  }
}

// 取消的原因用标准 AbortError（error.name === 'AbortError'）
const controller = new AbortController()
export const close = (): void => controller.abort(createAbortError('窗口已关闭'))

// 同一个资源上的操作按到达顺序串行，不同资源互不等待
const writes = createKeyedSerialQueue()

// 跨进程边界用 Result，不让异常穿透；收到后 match 或 unwrap 还原成 AppError
const saved = await Result.wrap(() => writes.run('settings', async () => readPort('8080')))
Result.match(saved, {
  ok: (port) => log.info(`端口已保存：${port}`),
  fail: (error) => log.warn(`${error.code}：${error.message}`),
})
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/core` | 任何进程 | 类型守卫、断言、`AppError`、`Result`、`Log`，以及数组、字符串、数字、空值、稳定 JSON、行 diff 这些高频小工具 |
| `@velaros-ai/core/assert` | 任何进程 | `assertInvariant`、`assertPresent`、`required` |
| `@velaros-ai/core/error` | 任何进程 | `AppError`、`createAbortError`、`createTimeoutError` |
| `@velaros-ai/core/logger` | 任何进程 | 日志运行时 `Log`、分域日志 `Logger`、transport 合同与回调、内存 transport |
| `@velaros-ai/core/logger/node` | Node | 文件 transport `createFileLogTransport`：有序 JSONL，按记录的本地日期分文件 |
| `@velaros-ai/core/result` | 任何进程 | `Result` |
| `@velaros-ai/core/utils/*` | 按文件 | 低频工具逐文件引：`TimerScope`、`KeyedSerialQueue`、`fetchWithTimeout`、`SqliteMigrations`、`ExclusiveSqliteLock` 等；`FilePersistence`、`FileSecretBox`、`RealPath` 只给 Node |
| [`@velaros-ai/core/platform`](src/platform/README.md) | 任何进程 | 跨平台约定：路径文本、shell 与进程命令规格、应用数据目录；另有 `/contracts`，以及只给 Node 的 `/shared-resources` |
| [`@velaros-ai/core/text-files`](src/text-files/README.md) | Node | 磁盘文本的无损读写：认编码、严格解码、按原编码写回、原子替换、有界读与流式读；另有 `/contracts` |
| [`@velaros-ai/core/path-rules`](src/path-rules/README.md) | Node | glob 匹配、.gitignore 判定、遍历时的忽略策略；另有 `/contracts` |

## 约定

- 产品代码不直接构造原生 `Error`：一般错误 `new AppError(code, message)`，要挂字段用 `AppError.withFields(code, message, fields)`，包 catch 到的未知值用 `AppError.from`，取消与超时用 `createAbortError`、`createTimeoutError`；`check:error-construction` 按语法树核对，测试与 spec 不算。
- `code` 是开放字符串：`ErrorCode` 列出通用码（`VALIDATION`、`NOT_FOUND`、`CONFLICT`、`CANCELLED`、`LIMIT` 等），领域码写在各包自己的常量表里；判断失败看 `code`，不看文字。
- 错误过 IPC 只带 `code`、`message`、`context`（`toJSON` / `AppError.fromJSON`，`Result` 就是这么传的）；`withFields` 挂的字段和 `cause` 过不去，要过边界的细节放进 `context`。
- 只收无领域语义、至少被两个不相邻领域复用的原语，`check:core-semantic-vocabulary` 拦领域词回流；有领域语义的放回拥有它的包。
