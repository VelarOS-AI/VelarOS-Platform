# @velaros-ai/core

VelarOS 各领域都可复用的无领域语义基础包：`src/` 里是基础原语，另外三个底层单元按目录放在包里（布局与 `@velaros-ai/velaros` 的能力单元一样，
每个单元有自己的模块卡片 `MODULE.md` 与不变量登记）。

Core 只负责：

- 断言、错误与 `Result`。
- 日志抽象与通用 transport。
- 运行时类型守卫。
- 数组、字符串、数字、JSON、空值、定时器、文件持久化与真实路径（`utils/RealPath`，判定安全用、会追悬空符号链接）等通用原语。
- `utils/ExclusiveSqliteLock` 提供独立 SQLite 排他事务的获取与释放：宿主注入零等待连接，负责稳定的锁库路径；忙锁返回 false，其余错误抛出，关闭失败保留连接供重试。支持原生驱动的字符串错误码与 Node 内置 SQLite 的数值错误码，产品元数据由宿主维护。
- `utils/SqliteMigrations` 注入同步 SQLite 连接与有序版本计划，只读评估历史，把本轮全部待执行迁移及版本记录放在同一事务内提交，失败整批回滚。数据库路径、连接配置与备份策略由宿主决定。
- `utils/FilePersistence` 的 `writeFileOnceSync` 完整写入并刷新临时文件后一次性发布，目标已存在时返回 false；`utils/FileSecretBox` 使用它创建本地密钥并提供 AES-256-GCM 文本加解密。宿主注入密钥位置与密文版本前缀，损坏密钥直接报错，并发创建者读取同一个正式文件。两者仅用于 Node 环境。
- `utils/KeyedSerialQueue` 的 `createKeyedSerialQueue()` 为每个资源串行执行操作，不同资源互不等待；异常只返回给对应调用者，队尾完成后回收资源。浏览器脚本、项目写回与聊天存储共用这一机制。
- `utils/fetchWithTimeout` 在同一截止时间内完成 Fetch 和响应正文消费，支持宿主注入 Fetch、调用者取消与超时中止。调用者传入正文消费函数和 `timeoutMs`；JSON、HTTP 状态码与产品错误映射由宿主决定。该入口与串行队列均可在浏览器使用。
- `stableStringify(value, options)` 按对象键排序并保留数组顺序；`omitKeys` 在各层排除调用者指定的字段，`rejectCircular` 拒绝循环引用。账号路由、离线授权与 Mod 签名共用排序机制，各自持有载荷、排除字段和信任规则；序列化保留自有的 `__proto__` 字段。

Core 不负责：

- Kernel ABI、协议、运行时、客户端或进程装配；这些统一属于 `@velaros-ai/kernel`。
- Agent 消息、会话、工具契约、上下文预算或执行语义；这些属于 `@velaros-ai/agent`。
- 模型计价；它属于 `@velaros-ai/model`。
- CLI 连接与路由；它属于 VelarOS-Termel 的 `@velaros-ai/cli`。
- Desktop、Workbench、Electron 或任何具体能力实现。

## 公开入口

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/core` | 高频通用原语 |
| `@velaros-ai/core/assert` | 断言 |
| `@velaros-ai/core/error` | `AppError` 与错误处理 |
| `@velaros-ai/core/logger` | logger 与 transport 抽象 |
| `@velaros-ai/core/logger/node` | Node 文件 transport：有序 JSONL、按记录日期分文件、写入与关闭回执 |
| `@velaros-ai/core/result` | `Result` |
| `@velaros-ai/core/utils/*` | 低频工具的逐文件入口 |
| `@velaros-ai/core/platform` | 跨平台约定：路径文本、shell 命令规格、进程与系统信息命令、应用与数据目录（`createPlatform`、`currentPlatform`）；不碰 Node 模块，渲染进程也能加载 |
| `@velaros-ai/core/platform/contracts` | 平台约定的可移植数据：环境变量表、shell 种类、命令规格、目录 |
| `@velaros-ai/core/platform/shared-resources` | VelarOS 产品家族共用的数据与资源目录（`velarosSharedResources`），只给 Node |
| `@velaros-ai/core/text-files` | 磁盘文本的无损读写：认编码（BOM、无 BOM 的 UTF-16、UTF-8、GB18030）并严格解码、按原编码写回、原子替换（fsync、权限位精确保留、多硬链接拒写、可核对原字节）、有界读与流式读；只给 Node |
| `@velaros-ai/core/text-files/contracts` | 文本编码词表、错误码与可移植数据 |
| `@velaros-ai/core/path-rules` | 路径命中规则：glob 匹配（目录前缀语义）、.gitignore 的解析与判定、遍历时的忽略策略（有注入的 `git check-ignore` 执行口就先问 git）；只给 Node |
| `@velaros-ai/core/path-rules/contracts` | 默认跳过的目录名与可移植数据 |

```ts
import { isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { currentPlatform } from '@velaros-ai/core/platform'
import { textCodec, textFileIo } from '@velaros-ai/core/text-files'
import { createIgnorePolicy, pathMatcher } from '@velaros-ai/core/path-rules'
```

三个单元住在 `src/` 下，各自的说明、骨干链路与不变量见 `src/platform/MODULE.md`、`src/text-files/MODULE.md`、`src/path-rules/MODULE.md`。
它们以前是三个独立的包（`@velaros-ai/platform`、`@velaros-ai/text-files`、`@velaros-ai/path-rules`），并进来后入口换成上表的子路径，名字不变（ADR 0014）。

## Node 文件日志

`createFileLogTransport({ filePath, id?, minLevel?, accepts? })` 实现现有 `LogTransport` 合同。
宿主决定文件基名、级别和记录筛选；transport 在提交时固化记录，按顺序追加 JSONL，
以每条记录的本地日期拆分文件。`resolveDatedLogFilePath(filePath, timestamp?)` 可获取对应路径。
错误堆栈、原因、BigInt 与循环引用可写入。一次写入失败会拒绝该次写入，但后续记录仍继续处理；
`flush` 等待已提交记录并报告首个尚未报告的失败，`dispose` 同步停止准入并共用关闭回执。
产品通知与运行环境装配由宿主持有。该入口依赖 Node 文件系统，与浏览器可用的 `logger` 入口分开。

## 归属规则

一个能力只有在同时满足以下条件时才允许进入 Core：

1. 不包含 Agent、Kernel、模型、产品或具体能力域语义。
2. 不依赖任何 VelarOS 领域包。
3. 至少被两个不相邻领域实际复用，且抽取后接口仍然自然。

否则放回拥有该语义的模块。`check:core-semantic-vocabulary` 会阻止领域词重新进入 Core；
包依赖方向由架构门禁检查。

`unifiedLineDiff` 是通用、有编辑距离上限的 unified diff，供脚本时间线与证据进度共用；调用方可配置上下文行数与编辑距离预算。
