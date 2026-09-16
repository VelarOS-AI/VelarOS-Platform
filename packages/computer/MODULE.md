# @velaros-ai/computer 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 五个工具都在 `src/impl/ComputerTools.ts` 一个文件里，是最先看的地方；其次是 `src/contract/` 的三个文件（产品面登记、注入面、常量表）和各实现文件类上方的接口。代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`。

## 这是什么

桌面控制（Computer Use）的能力包：让 agent 看见用户的主屏幕，并在整台机器上移动指针、点击、输入文字、按组合键。真正干活的是一个按需安装的 Python helper 子进程，本包负责拉起它、跟它按行分帧的 JSON 协议对话、把失败翻成模型看得懂的中文。

它不知道界面长什么样，也不知道插件怎么装：helper 装在哪、被没被用户停用，全由宿主经资源端口告诉它；装不装、怎么引导用户装，是宿主的事。

**坐标只有一套说法**：截图返回一个不透明的 `snapshotId`，之后的移动与点击要么带上同一次截图的 `snapshotId`（坐标按截图左上角算），要么显式声明 `coordinateSpace: 'global'`（虚拟桌面全局坐标）。换算与校验都在 helper 里，与真正的输入事件贴在一起，中间没有第二条能重算屏幕几何的路。

## 提供什么

本包对外只有三个面，都由接口控制：导出的类型只能来自 `src/contract/`（provides 登记的接口、requires、constants）和 `src/types/` 的公开数据文件，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对，没写进这一节的值导不出去。

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `computerTools` | `ComputerToolCollection`，元素是 `VelaTool` | 五个模型面工具 |
| `createComputerRuntime` | `ComputerRuntimeApi` | 桌面控制运行时：管着 helper 子进程的整个生命周期，宿主整个进程持有一份 |
| `createComputerHelperLocator` | `ComputerHelperLocatorApi` | 只查磁盘、不起进程地回答「helper 装没装、在哪、用哪个解释器」 |
| `createComputerKernelModule` | 上游的 `KernelModuleDefinition` | 挂进内核的模块 |
| `ComputerCapability` | 能力令牌，服务是 `ComputerCapabilityService` | 在内核里按工具名调用桌面控制工具 |

**注入面**，写在 `contract/requires.ts`，是宿主要塞进来的东西。本包只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `ComputerToolContext`，里面是宿主端口 `ComputerToolComputerApi` | 必须 | 宿主每次调工具时给。端口只有六个方法（探可用性、截图、移动、点击、输入、按键），每个都有工具在调，门禁逐方法核对 |
| `ComputerToolContextResolver`，放在 `CreateComputerKernelModuleOptions` 里 | 挂进内核且要按工具名调用时可选 | 不给就用注入的或模块自造的运行时兜一份上下文出来 |
| `ComputerRuntimePort`，放在 `CreateComputerKernelModuleOptions` 里 | 可选 | 宿主已经有一份运行时单例时注入它；默认归调用方所有，显式打开才随模块释放 |
| `ComputerSidecarManagerOptions`（含 `ComputerSidecarSpawner`、`ComputerSidecarProcess`） | 可选 | 创建运行时时给：可以整个换掉 helper 定位与子进程启动，自定义 sidecar 不必是 Python |
| `ComputerHelperLocatorOptions` 与 `ComputerResourcePort`（`ComputerResourceId`） | 可选 | 宿主的插件登记表经它交出额外资源根与停用开关；不给就只认平台约定的根，且认为没有被停用 |
| 环境变量，全部登记在 `ComputerEnvironmentVariables` | 可选 | 三个输入变量由宿主或开发者设 |

**数据面**是 `types/`，只放类型；**常量表**是 `contract/constants.ts`，只放值：`ComputerToolNames`、`ComputerToolCategoryId`、`ComputerCapabilityId`、`ComputerKernelModuleId`、`ComputerKernelModuleVersion`、`ComputerResourceLayout`、`ComputerOperationMetadata`、`ComputerErrorCodes`、`ComputerHelperErrorCodes`、`ComputerEnvironmentVariables`，以及被工具说明与 schema 直接引用的 `ComputerInputLimits`。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 三个面的全部 |
| `./contracts` | 任何进程，含浏览器、渲染进程 | 常量表与可移植数据 |

模型面的五个工具是本模块的主产品。它们都在 `src/impl/ComputerTools.ts`，每个工具的定义就是模型看到的全部信息面；execute 一行交给 `ComputerInputOperations`。

## 骨干链路

五个工具都在 `ComputerTools.ts`。每个动作都先过可用性门禁（不可用时是一句能引导用户的中文报错，而不是打到一半失败），再把入参交给宿主端口，最后把回执投影成模型看到的形状。

| 工具 | 链路 |
| --- | --- |
| `computer:screenshot` | 可用性门禁 → `ctx.computer.screenshot()` → helper 抓主屏、缩放到逻辑分辨率、登记一条截图绑定 → base64 提成模型可见图片，几何与 `snapshotId` 留在文本结果里 |
| `computer:move` | 可用性门禁 → 主屏坐标必须带 `snapshotId`（缺了当场拒绝，不降级成全局坐标）→ `ctx.computer.mouseMove(x, y, options)` → helper 校验绑定后换算成全局坐标再移动 → 回执投影回模型给的那套坐标，另列 `globalX/globalY` |
| `computer:click` | 同上，多带 `button` 与 `count`；helper 把绑定校验与真正的按下贴在一起，中间不重算屏幕几何 |
| `computer:type` | 可用性门禁 → `ctx.computer.typeText(text)` → helper 在当前焦点处原样输入 → 回执只有输入了多少个字符 |
| `computer:key` | 可用性门禁 → `ctx.computer.key(keys)` → helper 归一化键名后按下组合键 → 回执是实际按下的键序列 |

五个工具的分组与内核挂载在 `ComputerTools.ts` 末尾：内核操作名就是工具名，入参用工具自己的 schema 严格解析——内核面与模型面是同一套契约，没有第二份手写的入参门。

运行时那一段（`ctx.computer.*` 里面发生的事）：`ComputerSidecarManager` 懒启动 → `ComputerHelperLocator` 查磁盘找 helper 与自带 venv → 拉起子进程、等 `id=0` 的握手（有启动超时）→ 每个请求一行 JSON、按 id 关联应答 → helper 的领域错误按 `ComputerHelperErrorCodes` 翻成中文 → 进程退出或管道断开时一次性拒绝在飞请求并回到空闲。

## 依赖什么

- `@velaros-ai/core`：类型守卫、缺席值、`AppError`、`TimerScope` 定时器租约。
- `@velaros-ai/kernel`：内核模块定义与模块 SDK；`@velaros-ai/kernel/contracts` 出能力令牌与作用域等可移植数据。
- `@velaros-ai/tool-contract`：工具运行时规格、工具定义辅助、按工具名生成内核可调用操作。
- `@velaros-ai/agent/contracts`：`ToolPermission` 与能力声明形状。
- `zod`：wire 面入参校验。
- 随包的 Python helper 资产（`runtime/`）：mac / linux / win 三个脚本加一份共享模块；运行要的第三方库在按需安装的平台包自带 venv 里，本包不装、不联网。

运行时要宿主给的东西全部列在上一节的注入面里。工具说明里不写授权口径——那是产品决定，见「失败语义」。

## 状态归谁

- **helper 子进程**：归 `ComputerSidecarManager` 那一份运行时私有。状态机只有四档：`idle` → `starting` → `ready` → `dead`；`child`、`startPromise`、`ready` 三个字段是同一个状态的三个投影。
- **在飞请求表**：同上，在内存里，每条带自己的超时租约；进程退出、管道断开或 `dispose()` 时一次性拒绝。
- **stdout / stderr 缓冲**：同上；`teardown()` 会清空，上一个 helper 死在半行时的残片不会粘到下一个 helper 的握手行上。
- **截图绑定表**：不在本包，在 helper 进程里（`ScreenSnapshotRegistry`，按最近使用淘汰）。本包只搬运不透明的 `snapshotId`，自己不记屏幕几何。
- **helper 定位结果**：不缓存，每次现查磁盘；用户在设置里停用立刻生效。
- **授权记忆**：不归本模块。

## 生命周期

- 工具集合与常量表是纯值，随包加载即存在；`import` 本包不会启动任何进程。
- 运行时由宿主创建（`createComputerRuntime`），第一次真正用到桌面能力时才拉起 helper；`dispose()` 之后不再有任何状态迁移，后续调用一律报 `sidecarDisposed`。
- helper 死掉不是终局：状态机回到空闲，下一次调用重新拉起。
- 内核模块 `createComputerKernelModule` 在 `activate` 时注册能力服务；注入进来的运行时默认归调用方所有，显式 `disposeInjectedRuntime` 才随模块一起释放。

## 失败语义

- **默认失败关闭。** helper 没装、没权限、拉不起来一律拒绝这次动作，绝不静默降级成「没点到」。
- **`ensureAvailable` 永不抛。** 环境问题全落在结构化结果里（`available` / `reason` / `detail` / `permissions`），供界面引导用户。
- **helper 只认自包含 venv。** 找不到就判「未安装」，不回落系统 Python、不自己 `pip install`——那等于让 agent 往用户机器上装东西。唯一放行口是显式 `VELAROS_COMPUTER_PYTHON`。
- **截图绑定失效就拒绝。** 主屏切换、分辨率、缩放、原点任一变化，旧 `snapshotId` 作废；缺绑定的主屏坐标在 wire 面就被拒，不会走到运行时。
- **管道错误不会炸宿主。** helper 关掉输入或途中退出时的 `EPIPE` 在启动时就接住，按 `sidecarWriteFailed` 拒绝当前请求，不会变成宿主进程的未捕获异常。
- **授权口径是产品决定，不写进工具说明**：启用桌面控制这件事本身即授权，之后只剩操作系统权限那道门。模型据此做不了任何决定，所以它属于宿主的设置说明与卡片，不属于模型面。
- 完整错误码语义见 `src/contract/constants.ts` 的 `ComputerErrorCodes` 与 `ComputerHelperErrorCodes`；外面按错误码判断，不按错误类。

## 不变量

共 10 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 8 条、门禁 2 条。未验证 0 条。

## 非目标

- 不做界面：安装引导、停用开关、授权说明都在宿主，本包只交事实与错误码。
- 不装依赖、不联网：helper 的第三方库随按需安装的平台包走，本包一个 `pip install` 都不发。
- 不做「不看图拿几何」的模型面操作：`computer:screen_size` 已在 0.3.0 删除——点击与移动都要先截图，而截图结果本来就带全部几何；运行时方法 `screenSize()` 保留给宿主自己的界面。
- 不自己换算屏幕坐标：换算与校验都在 helper 里，与输入事件贴在一起；本包再算一遍就等于多开一条能绕过绑定的路。
- 不做网页内的点击与读取：那是另一个空间的事。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记产品面（类实现的 API 定义在类上方，这里 re-export；没有类的公开接口声明在这里），requires.ts 注入面，constants.ts 约定的常量表
  types/        只放类型：computer.ts 是可移植数据文件，protocol.ts 是 helper 的行协议形状，tool.ts 是五个工具的入参与能力声明形状
  impl/         ComputerTools.ts 放五个工具，其余一个类一个文件，文件名就是类名
  utils/        纯工具函数，按类别分文件；每个函数上方一句中文说明；tuning.ts 是全包的可调参数表
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
runtime/        随包发布的 Python helper 资产：三个平台脚本加一份共享模块（不是 TypeScript，不受 src 的规则约束）
```

**看代码的顺序**：`ComputerTools.ts` → `contract/` 的三个文件 → 需要时看 `ComputerSidecarManager` 类上方的状态机说明。

**常量分四处。** 对外承诺的（工具名、错误码、环境变量、写进工具说明与 schema 的上限）在 `contract/constants.ts`，工具说明里的数字用模板字符串引它；包内可调的（超时、缓冲）在 `utils/tuning.ts` 的 `ComputerTuning`；某个类里固定用的名单写成该类的 `private static readonly`；算法与格式里的数字就地写。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ComputerTools.ts` | 没有类 | 五个工具的定义、能力档、分组、内核挂载 |
| `ComputerInputOperations.ts` | `ComputerInputOperationsApi`（同文件） | 五个动作的执行体：可用性门禁、入参翻译、回执投影 |
| `ComputerSidecarManager.ts` | `ComputerRuntimeApi`（同文件，provides 登记） | helper 子进程的整个生命周期与行协议 |
| `ComputerHelperLocator.ts` | `ComputerHelperLocatorApi`（同文件，provides 登记） | 只查磁盘地回答 helper 在哪、用哪个解释器 |

实现分四层，上层可以调下层，下层不调上层：工具（`ComputerTools.ts`）→ 工具执行（`ComputerInputOperations.ts`）→ 运行时（`ComputerSidecarManager.ts`）→ helper 定位（`ComputerHelperLocator.ts`）。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下，只引 utils、types 与合同。

`./contracts` 入口会被渲染进程加载，它的整条引用链不碰 Node 模块。

`ComputerTools.ts` 改了要在差量报告里点名，人复核；`contract/` 的三个文件与 `runtime/` 的 helper 资产改了等于改对外契约与线协议，也要点名。
