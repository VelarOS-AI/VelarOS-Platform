# 0005: 跨平台兼容层与共享资源目录拆成 `@velaros-ai/platform`

- Status: accepted
- Date: 2026-09-15
- Owners: 模块所有权治理

## Context

`@velaros-ai/system` 收口后还带着两个和系统能力无关的入口：`./platform-compatibility`（路径文本、shell 命令规格、进程与系统信息命令、应用数据目录，不碰 Node，渲染进程也在用）和 `./shared-resources`（VelarOS 产品家族的共享数据、资源、账号目录放在哪）。
Desktop 的渲染进程有 4 处、Workbench 主进程与渲染进程有 8 处在用兼容层；两个产品仓对共享资源目录只各自持有一份「发布兼容投影」副本，并没有真正 import 那个入口。共享资源目录里按平台算数据目录的逻辑，和兼容层里算应用数据目录的逻辑是同一套操作系统惯例。

## Decision

新建 `@velaros-ai/platform`（`packages/platform`，归 core 域），三个入口：

- `.`：跨平台兼容层 `createPlatform` / `currentPlatform`，接口 `PlatformCompatibilityApi`；不碰 Node 模块，渲染进程可加载。
- `./contracts`：可移植数据（`ShellKind`、`RuntimePlatform`、`CommandSpec`、目录约定、环境变量表 `PlatformEnvironmentVariables`）。
- `./shared-resources`：`velarosSharedResources`，只给 Node 用。

`@velaros-ai/system` 改为依赖它：命令执行、shell 选择、文件操作都通过 `PlatformCompatibilityApi` 的方法拿 shell 规格与路径规整，不再持有自己的一份平台函数；系统包的入口只剩 `.` 与 `./contracts`。
包按模块所有权制治理（登记表、卡片、不变量、门禁），门禁为此支持没有工具的包：不登记 toolsFile、toolDefiner、hostPort。

命名去掉 `System` 前缀：`SystemPlatformCompatibility*` → `PlatformCompatibility*`，`createSystemPlatform` → `createPlatform`，`currentSystemPlatform` → `currentPlatform`，`SystemShellKind` 在本包叫 `ShellKind`。系统包的可移植契约不许 import，所以保留同名同值的 `SystemShellKind`，两边结构相同、可以互相赋值。共享资源目录的名字不变。

## Alternatives

- 留在 system 里：渲染进程为了几个纯函数依赖一个 Node 能力包；project 这类不许知道 system 的包也拿不到平台约定。
- 并进 `@velaros-ai/core`：core 是通用原语，不该带 VelarOS 品牌的目录约定和 Windows shell 选择规则。
- 共享资源目录单独成包：50 行代码，和兼容层的数据目录逻辑重复，不值一个发布单元。

## Security and privacy

本包不执行命令、不读写文件。危险判定与审批仍只在 `@velaros-ai/system`。环境变量 `VELAROS_SHELL_PATH`、`VELAROS_GIT_BASH`、`VELAROS_SHARED_DATA_ROOT` 登记在本包的表里；系统包的表里保留前两个（shell 选择也读它们）。

## Compatibility and migration

破坏性改动，随下一次 Platform 升级迁移：

| 收口前 | 收口后 |
| --- | --- |
| `import { currentSystemPlatform, createSystemPlatform, SystemPlatformCompatibility } from '@velaros-ai/system/platform-compatibility'` | `import { currentPlatform, createPlatform } from '@velaros-ai/platform'`；类不出包，`new SystemPlatformCompatibility(options)` 改 `createPlatform(options)` |
| `SystemPlatformCompatibilityApi`、`SystemPlatformCompatibilityOptions`、`SystemShellKind`（从兼容层入口拿的） | `PlatformCompatibilityApi`、`PlatformCompatibilityOptions`、`ShellKind` |
| `getSystemShellKind(path)` | `currentPlatform.getShellKind(path)` |
| `import { velarosSharedResources } from '@velaros-ai/system/shared-resources'` | `import { velarosSharedResources } from '@velaros-ai/platform/shared-resources'` |

## Validation

`check:module-ownership` 同时核对两个包；两个包的单测与验收、跨包危险判定语料、`check:package-catalog`、全仓 typecheck 通过；根入口与 `./contracts` 的引用链不碰 Node 由门禁核对。

## Consequences

系统包只剩系统能力，和产品壳、project 包一样从 `@velaros-ai/platform` 取平台约定。以后新的操作系统惯例（新的 shell、新的目录规则）改这一个包。
