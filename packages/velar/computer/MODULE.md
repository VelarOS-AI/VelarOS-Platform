# @velaros-ai/velar/computer 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/computer.d.ts`（由 `@AgentView` 从 `ComputerOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/ComputerOperations.ts` 类上方的接口，再看 `contract/` 的三个文件；运行时那一段看 `ComputerSidecarManager` 类上方的状态机说明。
> 门禁：`bun run check:module-ownership`、`bun run check:code-surface`。

## 这是什么

桌面控制（Computer Use）：代码面 `velar:computer` 的五个操作——`screenshot`、`move`、`click`、`typeText`、`key`——让模型看见用户的主屏幕，
并在整台机器上移动指针、点击、输入文字、按组合键。真正干活的是一个按需安装的 Python helper 子进程；本单元连同管它的运行时
（拉起、按行分帧的 JSON 协议、按 id 关联应答、把失败翻成中文）与只查磁盘的 helper 定位器一起交出去。

它不知道界面长什么样，也不知道插件怎么装：helper 装在哪、被没被用户停用，全由宿主经资源端口告诉它；装不装、怎么引导用户装，是宿主的事。

**坐标只有一套说法**：截图返回一个不透明的 `snapshotId`，之后的移动与点击要么带上同一次截图的 `snapshotId`（坐标按截图左上角算），
要么显式写 `coordinateSpace: 'global'`（虚拟桌面全局坐标）。换算与校验都在 helper 里，与真正的输入事件贴在一起，中间没有第二条能重算屏幕几何的路。

**图交给模型看，不进返回值**：screenshot 经交图通道把图交出去（跟在这次程序结果后面，只看一次），程序拿到的只有几何与 `snapshotId`。
所以模型一般分两段写：一段截图看屏幕，下一段按图上量出的坐标动手。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `computerOperations` | `ComputerOperationsApi` | 代码面 `computer` 命名空间的五个操作：入参核对、可用性门禁、结果投影，经空间端口 `ctx.computer` |
| `createComputerRuntime` | `ComputerRuntimeApi` | 桌面控制运行时：管着 helper 子进程的整个生命周期，宿主整个进程持有一份；它结构上满足空间端口，直接交给空间 |
| `createComputerHelperLocator` | `ComputerHelperLocatorApi` | 只查磁盘、不起进程地回答「helper 装没装、在哪、用哪个解释器」 |
| `VelarComputerModule` | 生成的合同（`contract/surface.ts`） | `velar:computer` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/code-surface/computer.d.ts` 同一份）与代码模版；空间挂这件能力时交给代码面的门 |

**常量表**是 `contract/constants.ts`，只放值：`ComputerHelperVersion`（随包 helper 资产的版本，宿主的安装器按它判断要不要重装）、
`ComputerResourceLayout`（平台包在磁盘上的布局与随包资产目录 `computer/runtime`）、`ComputerErrorCodes`、`ComputerHelperErrorCodes`、
`ComputerEnvironmentVariables`，以及写进声明给模型看的上限 `ComputerInputLimits`。

**数据面**是 `types/`：`types/computer.ts` 是可移植数据（模型面的入参与回执，加上经运行时与空间端口流过的形状）；
`types/protocol.ts` 是 helper 行协议的形状、`types/coordinates.ts` 是操作内部的坐标工作类型，两者都不出单元。

两个入口对应包清单 `exports` 里的 `./computer` 与 `./computer/contracts`，源文件是单元目录上的 `index.ts` 与 `contracts.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./computer` | Node 宿主 | 五个操作、运行时、定位器、注入面与它们用到的数据 |
| `./computer/contracts` | 任何进程，含浏览器、渲染进程 | 常量表、可移植数据、`VelarComputerModule` |

**注入面**在 `contract/requires.ts`。本单元只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `ComputerOperationContext`，里面是空间端口 `ComputerSpacePort` 与交图通道 `attachImage` | 必须 | 空间每次分发 `computer` 命名空间的调用时装好。端口只有六个方法（探可用性、截图、移动、点击、输入、按键），每个都有操作在调，门禁逐方法核对；把运行时直接交进来就满足它。没有交图通道就用不了 screenshot |
| `ComputerSidecarManagerOptions`（含 `ComputerSidecarSpawner`、`ComputerSidecarProcess`） | 可选 | 创建运行时时给：可以整个换掉 helper 定位与子进程启动，自定义 sidecar 不必是 Python |
| `ComputerHelperLocatorOptions` 与 `ComputerResourcePort`（`ComputerResourceId`） | 可选 | 宿主的插件登记表经它交出额外资源根与停用开关；不给就只认平台约定的根，且认为没有被停用 |
| 环境变量，全部登记在 `ComputerEnvironmentVariables` | 可选 | 三个输入变量由宿主或开发者设 |

**宿主怎么挂**：造一个带自己资源端口的定位器，再造一份运行时（`createComputerRuntime({ resolveHelper: () => locator.resolve() })`）；
空间把 `computer` 命名空间的五个操作挂到 `computerOperations` 上，每次调用给 `{ abortSignal, computer: runtime, attachImage }`，
交图通道接代码面的 `attach({ type: 'image-data', ... })`；门那边交 `VelarComputerModule`。宿主退出时 `runtime.dispose()`。

## 骨干链路

每个操作的顺序都固定：先查取消、再核对入参、再查可用性、最后做事。入参错了在拉起 helper 之前就拒绝；
桌面控制不可用时是一句能引导用户的中文报错，而不是打到一半失败。

| 操作 | 链路 |
| --- | --- |
| `screenshot` | 查取消 → 没有交图通道直接拒（`PLATFORM`，不拉起 helper）→ 可用性门禁 → `ctx.computer.screenshot()` → helper 抓主屏、缩到逻辑分辨率、登记一条截图绑定 → 图经 `ctx.attachImage` 交给模型（说明里带尺寸与 `snapshotId`）→ 返回值只剩几何与 `snapshotId` |
| `move` | 查取消 → `pointInput`：按截图量的坐标必须带 `snapshotId`（缺了当场拒，不降级成全局坐标）、全局坐标不许带，整数且在界内 → 可用性门禁 → `ctx.computer.mouseMove(x, y, options)` → helper 校验绑定后换算成全局坐标再移动 → 回执投影回模型给的那套坐标，另列 `globalX`、`globalY` |
| `click` | 同上，`clickInput` 多核对 `button` 与 `count`；helper 把绑定校验与真正的按下贴在一起，中间不重算屏幕几何 |
| `typeText` | 查取消 → 文字 1 到上限个字符 → 可用性门禁 → `ctx.computer.typeText(text)` → helper 在当前焦点处原样输入 → 回执只有输入了多少个字符 |
| `key` | 查取消 → 按键串非空白、不超上限 → 可用性门禁 → `ctx.computer.key(keys)` → helper 归一化键名后按下组合键 → 回执是实际按下的键序列 |

运行时那一段（`ctx.computer.*` 里面发生的事）：`ComputerSidecarManager` 懒启动 → `ComputerHelperLocator` 查磁盘找 helper 与自带 venv →
拉起子进程、等 `id=0` 的握手（有启动超时）→ 每个请求一行 JSON、按 id 关联应答 → helper 的领域错误按 `ComputerHelperErrorCodes` 翻成中文 →
进程退出或管道断开时一次性拒绝在飞请求并回到空闲。

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、缺席值、`AppError`、`TimerScope` 定时器租约）、`@velaros-ai/platform`（VelarOS 共享资源根）。
- 同包的单元：`@velaros-ai/velar/images`，只借它交给模型的一张图的形状 `ImageAttachment`（类型，不在运行时引用）。
- 只在验收里用：`@velaros-ai/code-surface`，跑端到端的程序、给代码模版做类型检查。
- 用到的 Node 内置模块：`child_process`（拉起 helper）、`fs`、`path`、`module`、`url`。只在根入口的引用链上；`./computer/contracts` 不碰。
- 随单元发布的 Python helper 资产（`runtime/`）：mac、linux、win 三个脚本加一份共享模块；运行要的第三方库在按需安装的平台包自带 venv 里，本单元不装、不联网。

## 状态归谁

- **helper 子进程**：归 `ComputerSidecarManager` 那一份运行时私有。状态机只有四档：`idle` → `starting` → `ready` → `dead`；`child`、`startPromise`、`ready` 三个字段是同一个状态的三个投影。
- **在飞请求表**：同上，在内存里，每条带自己的超时租约；进程退出、管道断开或 `dispose()` 时一次性拒绝。
- **stdout / stderr 缓冲**：同上；`teardown()` 会清空，上一个 helper 死在半行时的残片不会粘到下一个 helper 的握手行上。
- **截图绑定表**：不在本单元，在 helper 进程里（`ScreenSnapshotRegistry`，按最近使用淘汰）。本单元只搬运不透明的 `snapshotId`，自己不记屏幕几何。
- **helper 定位结果**：不缓存，每次现查磁盘；用户在设置里停用立刻生效。
- **五个操作**：无状态，每次调用核对、交给端口、投影，不留任何东西。

## 生命周期

- 操作、常量表与生成的模型面是纯值，随包加载即存在；`import` 本单元不会启动任何进程。
- 运行时由宿主创建（`createComputerRuntime`），第一次真正用到桌面能力时才拉起 helper；`dispose()` 之后不再有任何状态迁移，后续调用一律报 `sidecarDisposed`。
- helper 死掉不是终局：状态机回到空闲，下一次调用重新拉起。

## 失败语义

- **默认失败关闭。** helper 没装、没权限、拉不起来一律拒绝这次动作（`PERMISSION`），绝不静默降级成「没点到」；message 按原因引导用户，并明说不要自己用 pip 或命令装依赖。
- **`ensureAvailable` 永不抛。** 环境问题全落在结构化结果里（`available` / `reason` / `detail` / `permissions`），供界面引导用户。
- **helper 只认自包含 venv。** 找不到就判「未安装」，不回落系统 Python、不自己 `pip install`——那等于让 agent 往用户机器上装东西。唯一放行口是显式 `VELAROS_COMPUTER_PYTHON`。
- **入参与截图绑定不对是 `VALIDATION`。** 缺绑定的主屏坐标、混用两种坐标写法、越界、超上限在做事之前就拒；主屏切换、分辨率、缩放、原点任一变化，旧 `snapshotId` 作废，helper 拒绝，message 让模型重新截图。
- **宿主做不了是 `PLATFORM`。** 没有交图通道时 screenshot 整个不可用。
- **管道错误不会炸宿主。** helper 关掉输入或途中退出时的 `EPIPE` 在启动时就接住，按 `sidecarWriteFailed` 拒绝当前请求，不会变成宿主进程的未捕获异常。
- 代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里；运行时的专属错误码见 `contract/constants.ts` 的 `ComputerErrorCodes` 与 `ComputerHelperErrorCodes`，外面按错误码判断，不按错误类。

## 不变量

共 13 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 12 条、门禁 1 条。未验证 0 条。

## 非目标

- 不做界面：安装引导、停用开关、授权说明都在宿主，本单元只交事实与错误码。
- 不设确认闸（ADR 0009）：启用桌面控制这件事本身就是授权，之后只剩操作系统权限那道门。
- 不装依赖、不联网：helper 的第三方库随按需安装的平台包走，本单元一个 `pip install` 都不发。
- 不做「不看图拿几何」的模型面操作：点击与移动都要先截图，而截图结果本来就带全部几何；运行时方法 `screenSize()` 留给宿主自己的界面。
- 不自己换算屏幕坐标：换算与校验都在 helper 里，与输入事件贴在一起；本单元再算一遍就等于多开一条能绕过绑定的路。
- 不做网页内的点击与读取：那是浏览器的能力。

## 结构

```text
computer/
  contract/     对外合同：provides.ts 登记三个产品面接口，requires.ts 是调用上下文、空间端口与运行时的注入口，constants.ts 是常量表；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型：computer.ts 是可移植数据，protocol.ts 是 helper 的行协议形状，coordinates.ts 是坐标的工作类型
  impl/         一类一文件，文件名就是类名
  utils/        纯函数，按类别分文件，每个函数上方一句说明：input.ts（入参核对）、coordinates.ts（坐标交下去、回执投影回来）、availability.ts（可用性门禁与中文文案）、
                helper-paths.ts（资源根、脚本、venv 的位置）、process.ts（拉起子进程）、protocol.ts（行协议编解码）、tuning.ts（可调参数）
  index.ts      `./computer` 入口，只转发
  contracts.ts  `./computer/contracts` 入口，只转发
  template.js   代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  runtime/      随包发布的 Python helper 资产：三个平台脚本加一份共享模块（不是 TypeScript，不受上面的规则约束）
  spec/         不变量登记、验收测试、共用的假桌面与模型程序跑法
  test/         实现细节测试：入参核对，以及 runtime/ 下运行时与 helper 的测试
```

**分层。** 三层，上层只引下层：`ComputerOperations.ts`（代码面的五个操作）→ `ComputerSidecarManager.ts`（运行时）→ `ComputerHelperLocator.ts`（helper 定位）。
操作只经端口碰运行时，不直接 import 它。

**常量分四处。** 对外承诺的（错误码、环境变量、资源布局、写进声明的上限）在 `contract/constants.ts`，声明里写给模型的数字与它由验收核对一致；
单元内可调的（超时、缓冲）在 `utils/tuning.ts` 的 `ComputerTuning`；某个类里固定用的名单写成该类的 `private static readonly`；算法与格式里的数字就地写。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ComputerOperations.ts` | `ComputerOperationsApi`（同文件，provides 登记） | 代码面 `computer` 命名空间的五个操作：入参核对、可用性门禁、结果投影 |
| `ComputerSidecarManager.ts` | `ComputerRuntimeApi`（同文件，provides 登记） | helper 子进程的整个生命周期与行协议 |
| `ComputerHelperLocator.ts` | `ComputerHelperLocatorApi`（同文件，provides 登记） | 只查磁盘地回答 helper 在哪、用哪个解释器 |
