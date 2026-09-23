# @velaros-ai/core/platform

跨平台约定：路径文本怎么比、shell 命令怎么拼、进程怎么查怎么停、应用数据目录在哪，以及 VelarOS 产品家族共用的数据目录。只算文本、命令规格与路径，不读写磁盘、不起进程；给产品壳与各能力包用，拿到规格自己去执行。

## 用法

```ts
import { spawn } from 'node:child_process'

import { createPlatform, currentPlatform } from '@velaros-ai/core/platform'
import { velarosSharedResources } from '@velaros-ai/core/platform/shared-resources'

// 按当前进程回答：拿到能直接 spawn 的规格，用默认 shell 跑一段命令
const spec = currentPlatform.getShellCommandSpec('git status --short')
spawn(spec.file, spec.args, { windowsVerbatimArguments: spec.windowsVerbatimArguments })

// 按指定的平台与环境变量回答，在一台机器上算出另一个平台的结果
const windows = createPlatform({ platform: 'win32', env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' } })
windows.buildExecutableCandidates('git') // ['git', 'git.EXE', 'git.CMD']
windows.relativePathTextInside('c:\\WORK\\app\\src\\a.ts', 'C:/work/app') // 'src/a.ts'

// 路径包含判断只算字符串，符号链接要先解开再问
createPlatform({ platform: 'linux' }).isPathTextInside('/work/app/../secret', '/work/app') // false

// 产品家族共享目录（只给 Node）：只算路径，不建目录
const resourcesRoot = velarosSharedResources.resourcesRoot()
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/core/platform` | 任何进程 | 兼容层 `currentPlatform`、`createPlatform` 与它的选项 |
| `@velaros-ai/core/platform/contracts` | 任何进程 | 环境变量表 `PlatformEnvironmentVariables`，平台名、shell 种类、命令规格这些数据 |
| `@velaros-ai/core/platform/shared-resources` | Node | 产品家族共享目录 `velarosSharedResources`：数据根、资源目录、账号目录 |

## 约定

- 兼容层只按构造时给的平台与环境变量回答，缺省取当前进程；没有 `process` 的渲染进程里按 `linux`、空环境回答，要准就显式传 `platform`。
- CMD 下带换行、NUL 或 `%` 的参数，`quoteShellArg` 抛 `VALIDATION`，要改用原生 file + argv 执行；本平台没有的命令规格（非 Windows 要 taskkill、未知平台要系统指标）返回 `null`，不猜。
- 路径包含判断折叠 `.` 与 `..` 不越过根，win32 认两种分隔符、其他平台只认 `/`，大小写缺省按平台惯例（Windows、macOS 不区分）；不是完整绝对路径一律判不在里面。
- 读的环境变量都登记在 `PlatformEnvironmentVariables`：`VELAROS_SHELL_PATH`、`VELAROS_GIT_BASH` 定 Windows 默认 shell，`VELAROS_SHARED_DATA_ROOT` 整体覆盖共享数据根；资源与账号目录固定在它下面的 `shared/resources`、`shared/account/v1`。
