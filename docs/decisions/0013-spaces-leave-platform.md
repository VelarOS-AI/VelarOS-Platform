# 0013: 空间包移出 Platform：本机实现并进 velaros 各单元，装配归产品

- Status: accepted
- Date: 2026-09-18
- Owners: `@velaros-ai/velaros`（shell、sandbox、files、images、project 单元）

## Context

`@velaros-ai/system` 与 `@velaros-ai/project` 是两个空间包。代码面之后它们只剩两样东西：

- **装配表**（`createSystemSpace`、`createProjectSpace`）：给哪几件能力、每件用哪个端口、哪几件常驻，接成代码面的操作表。
  这是产品的决定——哪个产品开哪几个空间、空间里挂什么，本来就该由产品自己写。
- **实现**：system 里是本地内核（跑命令、后台任务、交互式控制台、shell 选择、进程约束、Windows 原生进程宿主、演练沙箱引擎，
  外加宿主界面要的进程、端口、指标、全局搜索）和系统空间的四个本机端口；project 里是项目给命令、沙箱、看图装的端口
  （钳在项目内、前台命令进项目资源门）与验证判据。这些是能力的实现，每个产品都要，不该各写一份。

用户的规则：「system project 这种产品包其实都不应该在当前仓库而是外部自己组装」「你把实现一起收进去」「外部能删除的就直接删除」。

## Decision

### 实现跟着能力走，每个单元多一个 `./local` 入口

本机实现并进它实现的那件能力。shell 与 sandbox 的根入口是渲染进程能加载的，本机实现要碰 Node，所以各开一个只给 Node 的入口；
接口、配置与数据仍从根入口导出（只导出类型，不破坏渲染进程可加载）。

| 入口 | 给什么 | 来自 |
| --- | --- | --- |
| `@velaros-ai/velaros/shell/local` | `createLocalShellHost`：`velaros:shell` 的执行端口 `ShellHostPort`（跑命令、列任务、刷新环境、停任务）在本机的实现，外加宿主界面的路径解析、环境体检、指标、进程、端口、控制台三件事；`createConfinedShellRunner`：把命令钉在一个根目录里的受约束执行器 | system 的本地内核、命令执行器、shell 选择、受管子进程、进程约束、`native/` |
| `@velaros-ai/velaros/sandbox/local` | `createLocalSandboxHost`：宿主的演练沙箱 `RehearsalSandboxHostPort` 在本机的实现（镜像、清单、差量、落回、丢弃、在镜像里跑命令） | system 的沙箱登记表与镜像工具 |
| `@velaros-ai/velaros/files/local` | `createLocalFilePort`：`FileSpacePort` 的本机实现（任意位置、原子替换）；`createLocalFileSearch`：给宿主界面的全局搜索 | 系统空间的文件端口、全局搜索 |
| `@velaros-ai/velaros/images/local` | `createLocalImagePort`：`ImageSpacePort` 的本机实现（macOS 上用 sips 缩图） | 系统空间的看图端口 |
| `@velaros-ai/velaros/project` | `projectCapabilityPorts`：项目给 `velaros:shell`、`velaros:sandbox`、`velaros:images` 装的端口；`projectVerificationPolicy`；宿主端口 `ProjectHostPort` | project 包的端口与验证判据 |

端口顺手拆清了一层：`ShellSpacePort` = 执行那四件 `ShellHostPort` + 空间的作用域与口径；`SandboxSurfacePort` = 宿主沙箱
`RehearsalSandboxHostPort`（在镜像里跑命令并进了宿主这一侧）+ 空间的 `resolveSource`。空间只补作用域，执行原样接上。

### 沙箱的隔离由沙箱自己兑现

原来本地内核把「cwd 落在镜像根里的普通命令」暗中转给沙箱专属的执行器。拆开之后这条暗路不要了：`velaros:sandbox` 的 run 走沙箱自己
持有的受约束执行器，隔离承诺不依赖产品怎么接线；普通 `velaros:shell` 命令就是普通命令（系统空间本来就不设边界，ADR 0009）。
错误码跟着改到各自的单元：`SHELL_UNAVAILABLE`、`SHELL_CONFINEMENT_UNAVAILABLE`、`SANDBOX_CONFLICT`、`SANDBOX_CHANGED`。

### 删掉的

- `packages/system`、`packages/project` 整包，连同 `createSystemSpace`、`createProjectSpace`、`ProjectSpaceId`、两张常驻表，
  以及只为它们存在的门禁登记、可移植入口检查、孤儿脚本 `check-packed-consumers.mjs`。门禁记着这两个目录，回来就红。
- 装配表的不变量（system INV-31、INV-35，project INV-1）作废：仓库里没有装配表了。「空间是一条真路」由仓库层的模版实跑测试守着，
  它照产品的写法在 `tests/support/spaces.ts` 装了两份空间。

### 产品怎么装

一个空间就是一张 `CapabilityOperationTable` 加一份 `MountedCapabilityModule[]`：每次调用按这次的上下文把端口塞进能力的调用上下文。
系统空间用四个本机实现（路径都经 shell 宿主的 `resolvePath`），项目空间用 `projectCapabilityPorts` 与项目内核。
写法照 `tests/support/spaces.ts`。

## Alternatives

- **本地内核整个留成一个非工具包**：它的每一块都是某件能力的实现，单独成包就是「工具在 velaros、实现在外面」，正是用户否掉的投影做法。否决。
- **装配表也并进 velaros**：哪个空间挂哪几件是产品的取舍，放进能力包等于替产品做决定。否决。
- **保留 cwd 路由**：隔离要靠产品把沙箱的路由接对才成立，接错了就静默裸跑。否决。
