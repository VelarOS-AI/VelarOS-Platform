# @velaros-ai/core/platform 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `impl/` 两个类上方的接口（`contract/provides.ts` 登记它们），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

VelarOS 各产品在不同操作系统上共用的约定：路径文本怎么比、shell 怎么调、进程怎么查怎么杀、应用与数据目录在哪，以及 VelarOS 产品家族的共享数据放在哪。
它只算文本、命令规格和路径，不读写磁盘、不启动进程；根入口不碰 Node 模块，渲染进程也能加载。从 `@velaros-ai/system` 拆出来（ADR 0005），因为它是产品壳和系统包共用的一义，不该跟着系统能力走。

以前是独立包 `@velaros-ai/platform`，2026-09-18 并进 `@velaros-ai/core` 成为它的一个单元，入口换成 `@velaros-ai/core/platform` 子路径（ADR 0014）。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：两件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `currentPlatform`、`createPlatform` | `PlatformCompatibilityApi` | 跨平台兼容层：按当前进程或指定的平台与环境变量回答 |
| `velarosSharedResources` | `VelarOSSharedResourcesApi` | 产品家族共享资源目录 |
| `PlatformEnvironmentVariables` | 契约常量表 | 本包读的环境变量 |

**数据面**是 `types/`，只放类型；**常量表**是 `contract/constants.ts`。`./platform/contracts` 入口就是常量表加可移植数据类型文件 `types/platform.ts`：`ShellKind`、`RuntimePlatform`、`CommandSpec`、编辑器与后台启动的定义、`PlatformEnvironmentVariables`；带进程环境变量类型的选项在 `types/options.ts`，从根入口导出。

三个入口对应 `@velaros-ai/core` 包清单 `exports` 里的 `./platform` 子路径，源文件是单元目录上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./platform` | Node 宿主与渲染进程 | 兼容层、它的接口与数据 |
| `./platform/contracts` | 任何进程，含浏览器 | 可移植数据 |
| `./platform/shared-resources` | Node 宿主 | 共享资源目录 |

没有注入面：本包不需要宿主塞任何东西，环境变量表登记在 `contract/constants.ts` 的 `PlatformEnvironmentVariables`。

## 骨干链路

本包没有模型面工具，链路是两件能力各自的回答方式：

| 能力 | 链路 |
| --- | --- |
| 跨平台兼容层 | `createPlatform(options)` 记下平台与环境变量（缺省读当前进程，浏览器里没有就当 linux）→ 每个方法只按记下的平台回答：路径文本按 Windows / POSIX 两种写法比较、包含判断按实例的平台规整（`isPathTextInside`、`relativePathTextInside`：折叠 `..` 不越过根，POSIX 只认 `/`）、shell 命令按种类拼参数并统一 UTF-8、终止命令与系统信息命令按平台给规格、应用数据目录按平台惯例算 → 不读写磁盘、不启动进程 |
| 共享资源目录 | `velarosSharedResources.dataRoot(options)`：`VELAROS_SHARED_DATA_ROOT` 设了就整体覆盖，否则 Windows 用 LOCALAPPDATA（退回 APPDATA），macOS 用 ~/Library/Application Support，Linux 用 XDG_DATA_HOME（退回 ~/.local/share）→ `resourcesRoot` 与 `accountRoot` 固定接在它下面 |

## 依赖什么

- 上游包：`@velaros-ai/core`（几个纯函数）。没有别的依赖。
- Node 内置模块只在 `./platform/shared-resources` 那条链上（`node:os`、`node:path`）；根入口与 `./platform/contracts` 整条引用链不碰 Node，门禁核对。
- 环境变量：`VELAROS_SHELL_PATH`、`VELAROS_GIT_BASH`（Windows 上选默认 shell）、`VELAROS_SHARED_DATA_ROOT`（覆盖共享数据根），都登记在 `PlatformEnvironmentVariables`。

## 状态归谁

- 兼容层实例只持有构造时给的平台与环境变量，没有别的状态；`currentPlatform` 是按当前进程创建的一份。
- 共享资源目录只算路径，不建目录、不写盘；建目录与安装产物归产品壳。

## 生命周期

没有需要释放的东西。`currentPlatform` 随进程存在；按别的平台回答就 `createPlatform(options)` 再造一个，用完即弃。

## 失败语义

- CMD 下无法安全转义的参数（带换行、NUL、`%`）：`quoteShellArg` 抛错，要求改用原生 argv 执行。
- 不是 Windows 却要 taskkill 规格、不是 macOS/Linux/Windows 却要指标命令：返回 null，不猜。
- 家目录不给时应用数据目录只返回相对的应用名。

## 不变量

共 4 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 3 条、门禁 1 条。未验证 0 条。

## 非目标

- 不执行任何命令、不读写任何文件：给出规格和路径，跑不跑归调用方。
- 不判断命令危不危险、不做审批：那是 `@velaros-ai/system` 的命令策略。
- 不解析 ps / lsof / netstat 的输出：解析器跟着系统包的进程能力走。

## 结构

```text
platform/
  contract/     对外合同：provides.ts 登记两件能力的 API（定义在各自类上方，这里 re-export），constants.ts 是环境变量表；没有注入面
  types/        只放类型：platform.ts 是可移植数据文件，options.ts 放带 Node 类型的选项
  impl/         一个类一个文件：PlatformCompatibility.ts、VelarOSSharedResources.ts
  utils/        platform.ts：shell 种类、命令规格、路径文本与 PATH 的小函数，每个上方一句说明
  index.ts             `./platform` 入口，只转发
  contracts.ts         `./platform/contracts` 入口，只转发
  shared-resources.ts  `./platform/shared-resources` 入口，只转发
```

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `PlatformCompatibility.ts` | `PlatformCompatibilityApi`（同文件，provides 登记） | 跨平台兼容层，外加 `currentPlatform` 与工厂 `createPlatform` |
| `VelarOSSharedResources.ts` | `VelarOSSharedResourcesApi`（同文件，provides 登记） | 产品家族共享资源目录 |

两个实现文件在同一层，互不依赖。`contract/` 的两个文件改了等于改对外契约，差量报告要点名。
