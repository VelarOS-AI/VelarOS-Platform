# @velaros-ai/velaros/browser 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/script/browser.d.ts`、`devtools.d.ts` 与 `cdp.d.ts`（由 `@AgentView` 从 `BrowserOperationsApi`、`DevtoolsOperationsApi`、`CdpOperationsApi` 与它们引用的类型生成），那是模型看到的全部。
> 先看 `impl/BrowserOperations.ts`、`impl/DevtoolsOperations.ts`、`impl/CdpOperations.ts` 类上方的接口，再看 `contract/` 的三个文件；运行时那一段看 `impl/electron/ElectronBrowserRuntime.ts`。
> 取舍记录在 ADR 0011（`docs/decisions/0011-browser-into-velar.md`）与 ADR 0012（`docs/decisions/0012-browser-low-level-capabilities.md`）。门禁：`bun run check:module-ownership`、`bun run check:script`。

## 这是什么

浏览器：代码面的三件能力，与它们底下的整套实现。模型可以从任何一层下手：

- **`velaros:browser`**（34 个操作）：进站与标签页、看页面（inspect、截图）、**页面脚本**（`evaluate` 与 `frames`：读页面、取数据、改 DOM 都在这里写 JavaScript）、
  **真实输入**（click、fill、press 这些组合，与 mouseMove、mouseDown、mouseUp、wheel、keyDown、keyUp、insertText 这些原子）、导航、等待、弹窗下载与权限、下载与导出 PDF。
- **`velaros:devtools`**（18 个操作）：控制台与网络诊断（页面打开起一直在录）、请求详情、缩放、常驻的网络规则、性能 trace 与堆快照、录屏、用户脚本。
  排障、调页面时才 import，驱动页面的声明因此保持小。
- **`velaros:cdp`**（4 个操作）：模型自己的一条 CDP 会话，发任意命令、读事件；和宿主那条会话分开，`reset` 或离站时撤掉它做过的一切。

页面 JS 做不到的才做成操作（ADR 0012）：真实输入（isTrusted、`:hover`、按键的默认行为）、导航与跨跳转的等待、像素与文件（截图、PDF、上传、下载）、
弹窗与权限、程序开始之前就在录的诊断、要分析引擎的 trace 与录屏；其余交给 evaluate 与 `velaros:cdp`。

底下是 CDP 协议层与两种页面驱动（外部 Chrome 的 CDP 连接、Electron 内嵌 WebContents，都收敛在 `BrowserPageDriver` 这一个协议后面）、
交互 / 页面数据 / 截图 / 性能四个引擎、Electron 会话运行时（会话动作队列、挂起事件、ref 分代、输入状态、模型的 CDP 会话）、站点工作区、登录墙门控、用户脚本存储、
动作策略，以及统一生成注入页面的脚本的构建器。随包带着 DevTools 性能引擎（`vendor/`）。

「站点」的身份是站点源：一个站点一个工作区，写只写当前根、读可回退到历史根。本单元不认识空间：浏览器空间挂哪几件能力、
给站点工作区配哪个文件端口，是产品的装配表的事（浏览器空间挂这三件，外加站点工作区上的 `velaros:files`）。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `browserOperations` | `BrowserOperationsApi` | 代码面 `browser` 命名空间的 34 个操作：查取消、核对入参、确认进了站点，经空间端口 `ctx.browser` 做事 |
| `devtoolsOperations` | `DevtoolsOperationsApi` | 代码面 `devtools` 命名空间的 18 个操作，同一个端口 |
| `cdpOperations` | `CdpOperationsApi` | 代码面 `cdp` 命名空间的 4 个操作：核对、限长、轮询事件，会话本身在运行时 |
| `createBrowserWorkspaceFileAccess` / `createBrowserSiteWorkspaceFileAccess` | `BrowserWorkspaceFileAccessApi` | 站点工作区的文件访问：写只写当前根、读可回退到历史根、按真实路径挡越界；宿主拿它拼空间端口，也拿它给浏览器空间做 `velaros:files` 的端口 |
| `createBrowserUserScriptStore` | `BrowserUserScriptManagerApi` | 用户脚本的存储与匹配：索引、源码文件、修订号、启停；宿主的 `manageUserScripts` 用它 |
| `createBrowserLoginGate` | `BrowserLoginGateApi` | 登录墙门控：包在空间端口外面，inspect、截图撞上登录墙时停下来请用户登录，每个站点每会话最多问一次 |
| `browserActionPolicy` | `BrowserActionPolicyApi` | 按宿主给的允许 / 拒绝表裁决一次动作 |
| `browserAddress`、`browserPreferences`、`browserScreenshotPolicy`（`./browser/renderer`） | `BrowserAddressApi`、`BrowserPreferencesApi`、`BrowserScreenshotPolicyApi` | 地址栏判据、偏好闭集、截图选项合成：渲染进程与主进程共用一份 |
| `browserComposition`（`./browser/renderer`） | `BrowserCompositionApi` | React 合成边界：宿主把受控页面交给产品树 |
| `createElectronBrowserRuntime`、`createBrowserKernelModule`、`BrowserRuntimeCapability`（`./browser/electron`） | `ElectronBrowserRuntimeApi` | Electron 主进程的浏览器运行时与挂进内核的模块 |
| `VelarBrowserModule`、`VelarDevtoolsModule`、`VelarCdpModule` | 生成的合同（`contract/surface.ts`） | 三件能力随包发布的模型面：模块名、放出去的方法、生成的完整声明与代码模版；空间挂它们时交给代码面的门 |

**常量表**是 `contract/constants.ts`，只放值：`BrowserErrorCodes`（没进站点、页面脚本抛错、结果超限、协议拒绝、框架不在），写进声明给模型看、入参核对也用的上限
`BrowserInspectLimits`、`BrowserActionLimits`、`BrowserWaitLimits`、`BrowserEvaluateLimits`、`BrowserProtocolLimits`、`BrowserFetchLimits`、
`BrowserDiagnosticsLimits`、`BrowserConditionLimits`、`BrowserCaptureLimits`、`BrowserPerformanceLimits`、`BrowserPendingEventLimits`、`BrowserUserScriptLimits`，
站点文件访问的 `BrowserFileLimits`，偏好闭集 `BrowserSearchEngineIds`、`BrowserAutomationModes`、`DefaultBrowserSearchEngine`、`DefaultBrowserAutomationMode`，
视图没接上的跨层标记 `BrowserViewNotAttachedReason`，与统一虚拟指针外观 `BrowserFallbackVirtualPointer`。

**数据面**是 `types/`：`types/browser.ts` 是可移植数据（三件能力的入参与回执，都带 `@AgentView`，就是模型面上的那些类型；
加上经空间端口、运行时与渲染进程流动的数据），随 `./browser/contracts` 出包；cdp、driver、electron、runtime、session、workspace、operations 各放本域的内部形状，
公开签名用到的从根入口按名导出。

四个入口对应包清单 `exports` 里的 `./browser`、`./browser/contracts`、`./browser/renderer`、`./browser/electron`，源文件是单元目录上的
`index.ts`、`contracts.ts`、`renderer.ts`、`electron.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./browser` | Node 宿主（产品主进程与测试） | 三件能力的操作、站点工作区与用户脚本的工厂、登录墙、动作策略，加四个入口里全部公开接口的类型 |
| `./browser/contracts` | 任何进程，含渲染进程与 IPC 契约 | 常量表、可移植数据、`VelarBrowserModule`、`VelarDevtoolsModule`、`VelarCdpModule`（引用链不碰 Node 内置模块） |
| `./browser/renderer` | 渲染进程 | 地址栏、偏好、截图选项三件纯策略与 React 合成边界 |
| `./browser/electron` | Electron 主进程 | 浏览器运行时与内核模块；这条链值 import `electron`（可选 peer），放进根入口会让不装 Electron 的宿主一加载就失败 |

**注入面**在 `contract/requires.ts`。本单元只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `BrowserOperationContext`，里面是空间端口 `BrowserSpacePort` 与交图通道 | 必须 | 空间每次分发 `browser`、`devtools`、`cdp` 的调用时装好。端口已经绑好会话与站点，扁平一层、只放操作真会调的方法，门禁逐方法核对；没有交图通道时截图照样落盘，只是模型看不到图 |
| `BrowserPageDriver`（含 `BrowserPageDriverDownloadItem` 与交给模型的 CDP 会话 `BrowserProtocolChannel`）、`BrowserExternalPageLauncher`、`BrowserSystemPointerDriver` | 可选 | 创建运行时时给：接别的浏览器后端、远程或容器里的浏览器、真实鼠标；不给就用内置的内嵌页面驱动、本机 Chrome 启动器与页面内指针。驱动做不到的（比如单开 CDP 会话）不实现，调用方如实回报不支持 |
| `BrowserLoginGatePort`，裁决形状是 `BrowserLoginGateDecision` | 用登录墙门控时必须 | 宿主装配端口时给；拿不到审批通道必须回 `approved: false`，不能静默放行 |
| `BrowserCompositionAdapter`、`ControlledBrowserSurface`、`ControlledBrowserSurfaceRenderOptions` | 可选 | 用 React 合成的宿主在渲染进程装 Provider 时给 |
| `CreateBrowserKernelModuleOptions`、`BrowserRuntimeCapabilityService` | 可选 | 宿主把运行时挂进内核时给 |

**宿主怎么挂**：主进程造一份 `createElectronBrowserRuntime`，按会话与站点拼出 `BrowserSpacePort`（要登录墙门控就 `createBrowserLoginGate(port).wrap(api)`）；
空间把 `browser`、`devtools`、`cdp` 三个命名空间挂到 `browserOperations`、`devtoolsOperations`、`cdpOperations` 上，每次调用给 `{ abortSignal, browser: port, attachImage }`，
交图通道接代码面的 `attach({ type: 'image-data', ... })`；门那边交 `VelarBrowserModule`、`VelarDevtoolsModule`、`VelarCdpModule`。
端口的 `sendProtocolCommand`、`readProtocolEvents`、`resetProtocolSession` 接运行时的同名方法；关会话、离站时模型的 CDP 会话由运行时与 `leave` 断开。

## 骨干链路

每个操作的顺序都固定：先查取消、再核对入参（`utils/input.ts`，顶层是严格对象）、再确认进了站点（`utils/site.ts`，没进抛 `BROWSER_SITE_NOT_OPEN`）、最后经端口做事。
入参错了或没进站点，端口上碰页面的方法一次都不调。

| 链路 | 操作 |
| --- | --- |
| 进站与标签页 | `open` → `ctx.browser.enterSite` 打开并绑定站点工作区 → 读页面状态；`state`（没进站点也能答，进了站点带上标签页与挂起事件）、`show`、`switchTab` 直通端口；`leave` 先断开模型的 CDP 会话再离站 |
| 看页面 | `inspect` 按常量表的上限向端口要；`screenshot` 把入参换成端口的截图选项 → 端口截图落盘 → 压缩图经 `ctx.attachImage` 交给模型 → 返回值只剩落盘位置、坐标换算与标注说明 |
| 页面脚本 | `evaluate` → 端口 `evaluateScript`（页面里：表达式或用 args 调的函数，结果整份 JSON 化，超上限只回长度，抛错回错误名、原话与 script 里的行列；`frame` 在框架自己的主世界里跑：内嵌页面走 `WebFrameMain`，外部浏览器经 `CdpFrameSessions`）→ `utils/script-outcome.ts` 解开成值或专属码；`frames` 直通 |
| 真实输入 | `click` 分两种：元素经 `performTargetActionWithRecovery`（页面里定位、滚进视口、确认没被挡住，再发真实鼠标事件；没找到时只在唯一确定的元素上按坐标补点），坐标直通 `clickCoordinates`；`fill` = 页面里全选 → `insertText`（空值按退格）→ 读控件状态；`hover`、`drag`、`upload` 直通；`press`、`keyDown`、`keyUp`、`mouseMove`、`mouseDown`、`mouseUp`、`wheel`、`insertText` 直通，按键照 `utils/keyboard.ts` 的键位表拼 CDP 事件，按着的修饰键与鼠标键记在会话上、带到每个输入事件里 |
| 导航 | `goto`、`back`、`forward`、`reload` 直通端口 |
| 等 | `waitForFunction` 由宿主轮询（`utils/waits.ts`）：每一拍跑一次判定式，跳转途中没回话的那一拍算没到，为真交回值；`waitForLoad` 经端口的 `waitForPage`（网络空闲没等到如实回没到）；`waitForEvent` 轮询挂起事件；三个等不到都抛 `TIMEOUT` |
| 挂起事件 | `handleDialog`、`handleDownload`、`handlePermission` 直通 |
| 下载与导出 | `download` → `fetchResource` 带着页面 cookie 下到站点工作区；`savePdf` → `exportPagePdf` |
| devtools | `diagnostics` 先按种类过滤再取窗口，分 console、network、page_error 三种形状；`request`、`zoom`、`network`、`startTrace`、`stopTrace`、`insight`、`heapSnapshot`、`startRecording`、`stopRecording` 直通；用户脚本七个动作映射到 `manageUserScripts`，`createUserScript` 一律先停用 |
| cdp | `send` → 端口 `sendProtocolCommand` → 结果按 JSON 限长；`events` 直通；`waitForEvent` 按间隔读事件缓冲（`utils/waits.ts`）；`reset` 直通 |

运行时那一段（`ctx.browser.*` 里面发生的事，宿主拼端口时接上）：Electron 运行时 → 会话动作队列按会话串行 → 交互 / 页面数据 / 截图 / 性能引擎 →
页面驱动（外部页面走 CDP 驱动，内嵌页面走 WebContents 驱动）→ 页面脚本 → 结果。弹窗、下载、权限由会话管理接住、挂起事件 broker 登记，超时按缺省结算。
模型的 CDP 会话由 `BrowserProtocolSessions` 管：第一次用到时经驱动的 `openProtocolChannel` 连上（内嵌页面在 debugger 上挂一条 flatten 子会话，外部浏览器再连一条 WebSocket），
事件进缓冲、序号只增，被它的 Fetch 拦下、30000 毫秒没人放行的请求替它放行；宿主自己的网络与 trace 监听只收宿主会话的事件。
外部浏览器里跨源 iframe 是另一个进程的 target：驱动第一次要框架时由 `CdpFrameSessions` 在驱动那条连接上开 `Target.setAutoAttach`，一层层挂上 iframe 子会话，
框架树接成一张表；子会话的顶层框架直接 `Runtime.evaluate`，同进程的子框架经 `DOM.resolveNode` 拿到 document 再 `Runtime.callFunctionOn`，都在框架的主世界里。

## 依赖什么

- 上游包：`@velaros-ai/core`（判定、日志、`AppError`、计时域；`@velaros-ai/core/platform` 的路径包含判定与进程树终止）、`@velaros-ai/kernel`（能力令牌与内核模块）。
- 同包的单元：`@velaros-ai/velaros/images`，只借交给模型的一张图的形状 `ImageAttachment`（类型）。
- 只在验收里用：`@velaros-ai/script`，跑端到端的程序、给代码模版做类型检查。
- 第三方：`zod`（入参核对）、`gifenc`（录屏编码），随包的 `vendor/devtools-performance-engine`（唯一登记过的懒加载目标，经包清单的子路径导入 `#devtools-performance-engine`）。
- 可选 peer：`electron`（只有 `./browser/electron` 那条链）、`react`（只有 `./browser/renderer` 的合成边界）。
- 用到的 Node 内置模块：`fs`、`path`、`os`、`child_process`（拉起外部 Chrome）、`crypto`、`url`。只在根入口与 `./browser/electron` 的引用链上。

## 状态归谁

- **持久状态**属于站点工作区：用户脚本的索引与源码、截图、下载、PDF、trace、堆快照、录屏，都在宿主给的 `workspaceRoot` 下。
- **进程内状态**只在实例上：会话动作队列、挂起事件、ref 分代、用户活动、登录墙账本、CDP 调试器占用、每个会话的输入状态（按着的键、鼠标键、指针位置）、
  模型的 CDP 会话（通道、事件缓冲、被拦下的请求）、外部驱动挂出的 iframe 子会话，全是运行时、驱动或门控实例的字段；模块级没有可变状态。
- 三件能力的操作是无状态单例，每次调用要什么都从 `ctx.browser` 现拿。
- 本单元不读 `VELAROS_*` 环境变量；只读 `LOCALAPPDATA` / `PROGRAMFILES` 找本机 Chrome（属操作系统惯例）。

## 生命周期

`createElectronBrowserRuntime(options, setup?)` → 宿主注册权限与 WebAuthn 处理、订阅回调 → 按站点开会话、拼端口 →
`createBrowserKernelModule({ runtime })` 挂进内核（可选）→ 退出时 `runtime.dispose()`。外部浏览器由 `BrowserExternalPageLauncher` 拉起，会话关掉时一并收。
模型的 CDP 会话第一次用到时才连，跨程序保留，`reset`、离站、会话关闭、外部浏览器切标签页时断开；断开时 Chromium 撤掉它设的仿真，被它拦着的请求直接失败。
操作、常量表与生成的模型面是纯值，随包加载即存在；DevTools 性能引擎只在第一次真跑 trace 时才加载。

## 失败语义

- **没进站点是 `BROWSER_SITE_NOT_OPEN`。** 要页面的操作一律先要求 open，message 这么说，端口上碰页面的方法一次都不调；`state` 照样回答。
- **入参不对是 `VALIDATION`。** 形状、取值与上限在做事之前核对，message 点名操作与字段；元素目标至少要有一样定位线索，认不出的键名当场拒绝。
- **页面脚本抛错是 `BROWSER_SCRIPT_FAILED`**，message 带页面的错误名、原话与它在 script 里的行列；**结果超过只为守住内存的上限是 `BROWSER_RESULT_TOO_LARGE`**，不交半截。
- **模型的 CDP 命令被协议拒绝是 `BROWSER_PROTOCOL_FAILED`**，message 是协议的原话；**指定的框架不在当前框架树里是 `BROWSER_FRAME_NOT_FOUND`**。
- **等不到是 `TIMEOUT`**：waitForFunction、waitForLoad、waitForEvent 与 cdp 的 waitForEvent 都抛，message 说等了什么、最后看到什么，不回「没等到」的结果。
- **点击没命中不假装成功**：没找到元素时只在唯一确定的元素上按坐标补点（`selectorRecovery`），恢复不了就如实回 `matched: false` 与原因；
  点中了却没有可见变化时附上 `actionEffect` 提示重新看页面；fill 碰上不是文本的控件如实回 `matched: false`。
- **视图没接上**带 `context.reason === BrowserViewNotAttachedReason`：运行时只陈述事实并打标记，补救办法归宿主；CDP 超时 `TIMEOUT`，网络类 `NETWORK`。
- **站点工作区越界**、用户脚本改了代码或范围之后未经确认就启用，一律当场拒绝而不是降级执行。
- 代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里；外面按错误码判断，不按错误类。

## 不变量

共 22 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排（INV-1～4、9、12、14 已作废，理由写在登记表开头）。
按检验方式：测试 17 条、门禁 2 条、文字 3 条。未验证 3 条。

## 非目标

- 不认识空间：浏览器空间、项目空间里挂不挂这三件能力、站点工作区配什么文件端口，是产品的装配表的事。
- 不做界面：登录引导、权限说明、下载位置选择都在宿主，本单元只交事实与错误码。
- 不管站点工作区里的普通文件读写：那是浏览器空间挂的 `velaros:files` 的事；本单元只写自己产出的截图、下载、PDF、trace、堆快照、录屏。
- 不把页面 JS 做得到的事再包一层操作：读表格、取正文、选下拉框、滚动、等元素出现，都在 evaluate 与 waitForFunction 里写。
- 不给模型的协议会话设闸：隔离靠会话分开，不靠确认与名单（ADR 0009）。
- 不做可复跑的步骤表（recipe）：程序本身就是步骤，存进代码面的脚本库、带参数重放。
- 不替程序折叠：不给上限就按只为守住内存的那个上限要，要多少由程序自己切。
- 不伪造做不到的事：外部浏览器不支持的能力（document-start 注入、这条连接够不着的跨源 iframe）明确回报不支持。
- CDP 侧的登录态与 Electron partition 互不相通：两套登录存储不桥接是判决，不是欠账。

## 结构

```text
browser/
  contract/     对外合同：provides.ts 登记产品面接口，requires.ts 是调用上下文、空间端口、页面驱动与运行时的注入口，constants.ts 是常量表；surface.ts 是生成的三件模型面（随包发布的声明）
  types/        只放类型：browser.ts 是可移植数据（模型面的入参与回执、经端口与运行时流动的数据）；cdp、driver、electron、runtime、session、workspace、operations 各放本域的内部形状；gifenc.d.ts 补 gifenc 的模块声明
  impl/         一类一文件，文件名就是类名：BrowserOperations.ts、DevtoolsOperations.ts、CdpOperations.ts 是三件能力的操作；
                electron/ 是 Electron 运行时、内嵌页面驱动与它上面的模型 CDP 会话，engines/ 是 CDP 那一侧的引擎，cdp/ 是协议层与外部浏览器上的模型 CDP 会话，
                session/ 是会话状态（动作队列、挂起事件、ref、模型 CDP 会话的账），workspace/ 是站点工作区、用户脚本与登录墙，policies/ 是纯策略
  utils/        纯函数，每个函数上方一句说明：input.ts 是入参核对，site.ts 是站点这一关，target.ts 是元素目标的归一，screenshot-options.ts 是截图选项与回执投影，
                script-outcome.ts 是页面脚本的结局换成值或专属码，waits.ts 是宿主轮询的三种等待，keyboard.ts 是键位表与键盘事件，pointer.ts 是虚拟指针与鼠标键位掩码，
                target-recovery.ts 是点击的坐标恢复；page-scripts/ 生成注入页面的脚本，cdp/、electron/ 是两侧的协议辅助；tuning.ts 是可调参数
  index.ts      `./browser` 入口，只转发
  contracts.ts  `./browser/contracts` 入口，只转发
  renderer.ts   `./browser/renderer` 入口，只转发
  electron.ts   `./browser/electron` 入口，只转发
  template.js   velaros:browser 的代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  devtools-template.js  velaros:devtools 的代码模版
  cdp-template.js       velaros:cdp 的代码模版
  vendor/       随包的 DevTools 性能引擎（生成产物，重新生成说明在目录里的 README.md）
  spec/         不变量登记、验收测试、共用的空间端口替身与模型程序跑法
  test/         实现细节测试：core/（纯策略、页面脚本求值、键位表、模型 CDP 会话的账、会话队列、站点工作区、用户脚本）、runtime/（诊断记录、视口、网络采集、内核模块、页面等待、导航策略）、
                tools/（诊断窗口、宿主轮询的等待、登录墙、坐标恢复），以及三份代码模版的实跑
```

**分层。** 上层只引下层：三件能力的操作（`BrowserOperations.ts`、`DevtoolsOperations.ts`、`CdpOperations.ts`）→ `electron/` → `engines/` →
`cdp/`、`session/`、`workspace/` → `policies/` 与 `BrowserComposition.ts`。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下。
操作只经端口碰运行时，不直接 import 它；Electron 只许在 `impl/electron/`、`utils/electron/` 与 `types/electron.ts` 里 import。

**常量分四处。** 对外承诺的（错误码、写进声明的上限与缺省、偏好闭集、跨层标记）在 `contract/constants.ts`，声明里写给模型的数字与它由验收核对一致；
单元内可调的（超时、缓冲、保留条数、截图压缩、轮询间隔）在 `utils/tuning.ts` 的 `BrowserTuning`；某个类里固定用的名单写成该类的 `private static readonly`；
规则本身的数据跟着规则写（键位表在 `utils/keyboard.ts`）。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。
`contract/` 的三个文件改了等于改对外契约，要在差量报告里点名。
