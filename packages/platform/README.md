# @velaros-ai/platform

> 模块卡片见 [MODULE.md](./MODULE.md)。本文是操作手册。

VelarOS 各产品在不同操作系统上共用的约定：路径文本、shell 命令规格、进程与系统信息命令、应用与数据目录，以及 VelarOS 产品家族的共享数据放在哪。
只算文本、命令规格和路径，不读写磁盘、不启动进程。从 `@velaros-ai/system` 拆出（ADR 0005）。

- `@velaros-ai/platform`：跨平台兼容层 `createPlatform` / `currentPlatform` 与它的接口和数据。不碰 Node 模块，渲染进程也能 import。
- `@velaros-ai/platform/contracts`：可移植数据，浏览器也能用。
- `@velaros-ai/platform/shared-resources`：`velarosSharedResources`，只给 Node 用。

```ts
import { createPlatform, currentPlatform } from '@velaros-ai/platform'
import { velarosSharedResources } from '@velaros-ai/platform/shared-resources'

currentPlatform.getShellCommandSpec('git status')
createPlatform({ platform: 'win32' }).getTerminateCommand(4242, true)
velarosSharedResources.resourcesRoot()
```

从 `@velaros-ai/system` 迁过来时：`@velaros-ai/system/platform-compatibility` → `@velaros-ai/platform`，`createSystemPlatform` → `createPlatform`，`currentSystemPlatform` → `currentPlatform`，
`SystemPlatformCompatibilityApi` → `PlatformCompatibilityApi`，`SystemShellKind` → `ShellKind`；`@velaros-ai/system/shared-resources` → `@velaros-ai/platform/shared-resources`，名字不变。
