# @velaros-ai/velar/browser 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/browser.d.ts` 与 `devtools.d.ts`（由 `@AgentView` 从 `BrowserOperationsApi`、`DevtoolsOperationsApi` 与它们引用的类型生成），那是模型看到的全部。
> 先看 `impl/BrowserOperations.ts`、`impl/DevtoolsOperations.ts` 类上方的接口，再看 `contract/` 的三个文件；运行时那一段看 `impl/electron/ElectronBrowserRuntime.ts`。
> 取舍记录在 ADR 0011（`docs/decisions/0011-browser-into-velar.md`）。门禁：`bun run check:module-ownership`、`bun run check:code-surface`。

## 这是什么

浏览器：代码面的两件能力，与它们底下的整套实现。

- **`velar:browser`**（48 个操作）：进站与标签页、看页面、按元素或坐标动手、等页面到位、弹窗下载与权限、取表格列表正文、下载与导出 PDF。
- **`velar:devtools`**（22 个操作）：控制台与网络诊断、请求详情、页面存储、视口与缩放、网络条件与环境仿真、性能 trace 与堆快照、录屏、用户脚本。
  排障、调页面时才 import，驱动页面的声明因此保持小。

底下是 CDP 协议层与两种页面驱动（外部 Chrome 的 CDP 连接、Electron 内嵌 WebContents，都收敛在 `BrowserPageDriver` 这一个协议后面）、
交互 / 页面数据 / 截图 / 性能四个引擎、Electron 会话运行时（会话动作队列、挂起事件、ref 分代）、站点工作区、登录墙门控、用户脚本存储、
动作策略，以及统一生成注入页面的脚本的构建器。随包带着 DevTools 性能引擎（`vendor/`）。

「站点」的身份是站点源：一个站点一个工作区，写只写当前根、读可回退到历史根。本单元不认识空间：浏览器空间挂哪几件能力、
给站点工作区配哪个文件端口，是产品的装配表的事（ADR 0011：浏览器空间挂这两件，外加站点工作区上的 `velar:files`）。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `browserOperations` | `BrowserOperationsApi` | 代码面 `browser` 命名空间的 48 个操作：查取消、核对入参、确认进了站点，经空间端口 `ctx.browser` 做事 |
| `devtoolsOperations` | `DevtoolsOperationsApi` | 代码面 `devtools` 命名空间的 22 个操作，同一个端口 |
| `createBrowserWorkspaceFileAccess` / `createBrowserSiteWorkspaceFileAccess` | `BrowserWorkspaceFileAccessApi` | 站点工作区的文件访问：写只写当前根、读可回退到历史根、按真实路径挡越界；宿主拿它拼空间端口，也拿它给浏览器空间做 `velar:files` 的端口 |
| `createBrowserUserScriptStore` | `BrowserUserScriptManagerApi` | 用户脚本的存储与匹配：索引、源码文件、修订号、启停；宿主的 `manageUserScripts` 用它 |
| `createBrowserLoginGate` | `BrowserLoginGateApi` | 登录墙门控：包在空间端口外面，inspect、截图撞上登录墙时停下来请用户登录，每个站点每会话最多问一次 |
| `browserActionPolicy` | `BrowserActionPolicyApi` | 按宿主给的允许 / 拒绝表裁决一次动作 |
| `browserAddress`、`browserPreferences`、`browserScreenshotPolicy`（`./browser/renderer`） | `BrowserAddressApi`、`BrowserPreferencesApi`、`BrowserScreenshotPolicyApi` | 地址栏判据、偏好闭集、截图选项合成：渲染进程与主进程共用一份 |
| `browserComposition`（`./browser/renderer`） | `BrowserCompositionApi` | React 合成边界：宿主把受控页面交给产品树 |
| `createElectronBrowserRuntime`、`createBrowserKernelModule`、`BrowserRuntimeCapability`（`./browser/electron`） | `ElectronBrowserRuntimeApi` | Electron 主进程的浏览器运行时与挂进内核的模块 |
| `VelarBrowserModule`、`VelarDevtoolsModule` | 生成的合同（`contract/surface.ts`） | 两件能力随包发布的模型面：模块名、放出去的方法、生成的完整声明与代码模版；空间挂这两件时交给代码面的门 |

**常量表**是 `contract/constants.ts`，只放值：`BrowserErrorCodes`，写进声明给模型看、入参核对也用的上限
`BrowserInspectLimits`、`BrowserActionLimits`、`BrowserExtractLimits`、`BrowserEvaluateLimits`、`BrowserPageDataLimits`、`BrowserFetchLimits`、
`BrowserDiagnosticsLimits`、`BrowserConditionLimits`、`BrowserCaptureLimits`、`BrowserPerformanceLimits`、`BrowserPendingEventLimits`、`BrowserUserScriptLimits`，
站点文件访问的 `BrowserFileLimits`，偏好闭集 `BrowserSearchEngineIds`、`BrowserAutomationModes`、`DefaultBrowserSearchEngine`、`DefaultBrowserAutomationMode`，
视图没接上的跨层标记 `BrowserViewNotAttachedReason`，与统一虚拟指针外观 `BrowserFallbackVirtualPointer`。

**数据面**是 `types/`：`types/browser.ts` 是可移植数据（两件能力的入参与回执，都带 `@AgentView`，就是模型面上的那些类型；
加上经空间端口、运行时与渲染进程流动的数据），随 `./browser/contracts` 出包；cdp、driver、electron、runtime、session、workspace、operations 各放本域的内部形状，
公开签名用到的从根入口按名导出。

四个入口对应包清单 `exports` 里的 `./browser`、`./browser/contracts`、`./browser/renderer`、`./browser/electron`，源文件是单元目录上的
`index.ts`、`contracts.ts`、`renderer.ts`、`electron.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./browser` | Node 宿主（产品主进程与测试） | 两件能力的操作、站点工作区与用户脚本的工厂、登录墙、动作策略，加四个入口里全部公开接口的类型 |
| `./browser/contracts` | 任何进程，含渲染进程与 IPC 契约 | 常量表、可移植数据、`VelarBrowserModule`、`VelarDevtoolsModule`（引用链不碰 Node 内置模块） |
| `./browser/renderer` | 渲染进程 | 地址栏、偏好、截图选项三件纯策略与 React 合成边界 |
| `./browser/electron` | Electron 主进程 | 浏览器运行时与内核模块；这条链值 import `electron`（可选 peer），放进根入口会让不装 Electron 的宿主一加载就失败 |

**注入面**在 `contract/requires.ts`。本单元只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `BrowserOperationContext`，里面是空间端口 `BrowserSpacePort` 与交图通道 | 必须 | 空间每次分发 `browser`、`devtools` 的调用时装好。端口已经绑好会话与站点，扁平一层、只放操作真会调的方法，门禁逐方法核对；没有交图通道时截图照样落盘，只是模型看不到图 |
| `BrowserPageDriver`（含 `BrowserPageDriverDownloadItem`）、`BrowserExternalPageLauncher`、`BrowserSystemPointerDriver` | 可选 | 创建运行时时给：接别的浏览器后端、远程或容器里的浏览器、真实鼠标；不给就用内置的内嵌页面驱动、本机 Chrome 启动器与页面内指针 |
| `BrowserLoginGatePort`，裁决形状是 `BrowserLoginGateDecision` | 用登录墙门控时必须 | 宿主装配端口时给；拿不到审批通道必须回 `approved: false`，不能静默放行 |
| `BrowserCompositionAdapter`、`ControlledBrowserSurface`、`ControlledBrowserSurfaceRenderOptions` | 可选 | 用 React 合成的宿主在渲染进程装 Provider 时给 |
| `CreateBrowserKernelModuleOptions`、`BrowserRuntimeCapabilityService` | 可选 | 宿主把运行时挂进内核时给 |

**宿主怎么挂**：主进程造一份 `createElectronBrowserRuntime`，按会话与站点拼出 `BrowserSpacePort`（要登录墙门控就 `createBrowserLoginGate(port).wrap(api)`）；
空间把 `browser`、`devtools` 两个命名空间挂到 `browserOperations`、`devtoolsOperations` 上，每次调用给 `{ abortSignal, browser: port, attachImage }`，
交图通道接代码面的 `attach({ type: 'image-data', ... })`；门那边交 `VelarBrowserModule`、`VelarDevtoolsModule`。

## 骨干链路

每个操作的顺序都固定：先查取消、再核对入参（`utils/input.ts`，顶层是严格对象）、再确认进了站点（`utils/site.ts`，没进抛 `BROWSER_SITE_NOT_OPEN`）、最后经端口做事。
入参错了或没进站点，端口上碰页面的方法一次都不调。

| 链路 | 操作 |
| --- | --- |
| 进站与标签页 | `open` → `ctx.browser.enterSite` 打开并绑定站点工作区 → 读页面状态；`leave`、`state`（没进站点也能答）、`show`、`tabs`、`switchTab` 直通端口 |
| 看页面 | `inspect`、`query`、`media`、`evaluate` 按常量表的上限向端口要（不替模型折叠）；`screenshot` 把入参换成端口的截图选项 → 端口截图落盘 → 压缩图经 `ctx.attachImage` 交给模型 → 返回值只剩落盘位置、坐标换算与标注说明 |
| 按元素动手 | `click`、`fill`、`select`、`check`、`hover`、`focus`、`clear`、`selectText`、`scrollIntoView`：目标归一（`@` 开头当 ref，其余当 CSS selector，或定位线索）→ `performTargetActionWithRecovery` → 点击没找到元素时只在唯一确定的元素上按坐标补点，点中了却没有可见变化时附上提示 |
| 导航与输入 | `goto`、`back`、`forward`、`reload`、`scroll`、`type`、`press`、`mouseMove`、`clickAt`、`drag`、`upload` 直通端口 |
| 等 | `waitForSelector` 直通；`waitForText`、`waitForUrl`、`waitForFunction`、`waitForLoad`、`wait` 共用端口的 `waitForPage` |
| 挂起事件 | `events` 列表；`waitForEvent` 按间隔轮询到指定类别出现或超时；`handleDialog`、`handleDownload`、`handlePermission` 直通 |
| 取内容 | `table`、`list`、`paginate`、`content` 经 `BrowserExtraction`：在页面里跑本单元生成的提取脚本，载荷先 JSON.stringify 再经求值通道取回（绕开通道的数组截断），超上限明确失败；翻页点下一页走端口的点击 |
| 下载与导出 | `download` → `fetchResource` 带着页面 cookie 下到站点工作区；`savePdf` → `exportPagePdf` |
| devtools | `diagnostics` 先按种类过滤再取窗口，分 console、network、page_error 三种形状；`request`、`storage`、`setViewport`、`zoom`、`network`、`emulate`、`startTrace`、`stopTrace`、`insight`、`heapSnapshot`、`startRecording`、`stopRecording` 直通；用户脚本九个动作映射到 `manageUserScripts`，`createUserScript` 一律先停用 |

运行时那一段（`ctx.browser.*` 里面发生的事，宿主拼端口时接上）：Electron 运行时 → 会话动作队列按会话串行 → 交互 / 页面数据 / 截图 / 性能引擎 →
页面驱动（外部页面走 CDP 驱动，内嵌页面走 WebContents 驱动）→ 页面脚本 → 结果。弹窗、下载、权限由会话管理接住、挂起事件 broker 登记，超时按缺省结算。

## 依赖什么

- 上游包：`@velaros-ai/core`（判定、日志、`AppError`、计时域）、`@velaros-ai/kernel`（能力令牌与内核模块）、`@velaros-ai/platform`（路径包含判定、进程树终止）。
- 同包的单元：`@velaros-ai/velar/images`，只借交给模型的一张图的形状 `ImageAttachment`（类型）。
- 只在验收里用：`@velaros-ai/code-surface`，跑端到端的程序、给代码模版做类型检查。
- 第三方：`zod`（入参核对）、`gifenc`（录屏编码），随包的 `vendor/devtools-performance-engine`（唯一登记过的懒加载目标，经包清单的子路径导入 `#devtools-performance-engine`）。
- 可选 peer：`electron`（只有 `./browser/electron` 那条链）、`react`（只有 `./browser/renderer` 的合成边界）。
- 用到的 Node 内置模块：`fs`、`path`、`os`、`child_process`（拉起外部 Chrome）、`crypto`、`url`。只在根入口与 `./browser/electron` 的引用链上。

## 状态归谁

- **持久状态**属于站点工作区：用户脚本的索引与源码、截图、下载、PDF、trace、堆快照、录屏，都在宿主给的 `workspaceRoot` 下。
- **进程内状态**只在实例上：会话动作队列、挂起事件、ref 分代、用户活动、登录墙账本、CDP 调试器占用，全是运行时或门控实例的字段；模块级没有可变状态。
- 两件能力的操作与结构化取内容的执行者是无状态单例，每次调用要什么都从 `ctx.browser` 现拿。
- 本单元不读 `VELAROS_*` 环境变量；只读 `LOCALAPPDATA` / `PROGRAMFILES` 找本机 Chrome（属操作系统惯例）。

## 生命周期

`createElectronBrowserRuntime(options, setup?)` → 宿主注册权限与 WebAuthn 处理、订阅回调 → 按站点开会话、拼端口 →
`createBrowserKernelModule({ runtime })` 挂进内核（可选）→ 退出时 `runtime.dispose()`。外部浏览器由 `BrowserExternalPageLauncher` 拉起，会话关掉时一并收。
操作、常量表与生成的模型面是纯值，随包加载即存在；DevTools 性能引擎只在第一次真跑 trace 时才加载。

## 失败语义

- **没进站点是 `BROWSER_SITE_NOT_OPEN`。** 要页面的操作一律先要求 open，message 这么说，端口上碰页面的方法一次都不调；`state` 照样回答。
- **入参不对是 `VALIDATION`。** 形状、取值与上限在做事之前核对，message 点名操作与字段；元素目标至少要有一样定位线索。
- **点击没命中不假装成功**：没找到元素时只在唯一确定的元素上按坐标补点（`selectorRecovery`），恢复不了就如实回 `matched: false` 与原因；
  点中了却没有可见变化时附上 `actionEffect` 提示重新看页面。
- **提取超上限明确失败**（`EXECUTION_FAILED`），不把半截结果当完整结果交回；页面脚本报错同样如实上报。
- **视图没接上**带 `context.reason === BrowserViewNotAttachedReason`：运行时只陈述事实并打标记，补救办法归宿主；CDP 超时 `TIMEOUT`，网络类 `NETWORK`。
- **站点工作区越界**、用户脚本改了代码或范围之后未经确认就启用，一律当场拒绝而不是降级执行。
- 代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里；外面按错误码判断，不按错误类。

## 不变量

共 16 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排（INV-1～4、9、12、14 已作废，理由写在登记表开头）。
按检验方式：测试 13 条、门禁 2 条、文字 1 条。未验证 1 条。

## 非目标

- 不认识空间：浏览器空间、项目空间里挂不挂这两件能力、站点工作区配什么文件端口，是产品的装配表的事。
- 不做界面：登录引导、权限说明、下载位置选择都在宿主，本单元只交事实与错误码。
- 不管站点工作区里的普通文件读写：那是浏览器空间挂的 `velar:files` 的事；本单元只写自己产出的截图、下载、PDF、trace、堆快照、录屏。
- 不做可复跑的步骤表（recipe）：程序本身就是步骤，存进代码面的脚本库、带参数重放。
- 不替程序折叠：不给上限就按只为守住内存的那个上限要，要多少由程序自己切。
- 不伪造做不到的事：外部浏览器不支持的能力（document-start 注入之类）明确回报不支持。
- CDP 侧的登录态与 Electron partition 互不相通：两套登录存储不桥接是判决，不是欠账。

## 结构

```text
browser/
  contract/     对外合同：provides.ts 登记产品面接口，requires.ts 是调用上下文、空间端口与运行时的注入口，constants.ts 是常量表；surface.ts 是生成的两件模型面（随包发布的声明）
  types/        只放类型：browser.ts 是可移植数据（模型面的入参与回执、经端口与运行时流动的数据）；cdp、driver、electron、runtime、session、workspace、operations 各放本域的内部形状；gifenc.d.ts 补 gifenc 的模块声明
  impl/         一类一文件，文件名就是类名：BrowserOperations.ts、DevtoolsOperations.ts 是两件能力的操作，BrowserExtraction.ts 是结构化取内容；
                electron/ 是 Electron 运行时与内嵌页面驱动，engines/ 是 CDP 那一侧的引擎，cdp/ 是协议层，session/ 是会话状态，workspace/ 是站点工作区、用户脚本与登录墙，policies/ 是纯策略
  utils/        纯函数，每个函数上方一句说明：input.ts 是入参核对，site.ts 是站点这一关，target.ts 是元素目标的归一，screenshot-options.ts 是截图选项与回执投影，
                extraction.ts 是取内容的底层几步，target-recovery.ts 是点击的坐标恢复；page-scripts/ 生成注入页面的脚本，cdp/、electron/ 是两侧的协议辅助；tuning.ts 是可调参数
  index.ts      `./browser` 入口，只转发
  contracts.ts  `./browser/contracts` 入口，只转发
  renderer.ts   `./browser/renderer` 入口，只转发
  electron.ts   `./browser/electron` 入口，只转发
  template.js   velar:browser 的代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  devtools-template.js  velar:devtools 的代码模版
  vendor/       随包的 DevTools 性能引擎（生成产物，许可证与重新生成说明在目录里）
  spec/         不变量登记、验收测试、共用的空间端口替身与模型程序跑法
  test/         实现细节测试：core/（纯策略、页面脚本、会话队列、站点工作区、用户脚本）、runtime/（诊断记录、视口、网络采集、内核模块、页面等待、导航策略）、
                tools/（诊断窗口、取内容载荷、翻页、登录墙、坐标恢复），以及两份代码模版的实跑
```

**分层。** 上层只引下层：两件能力的操作（`BrowserOperations.ts`、`DevtoolsOperations.ts`）→ 结构化取内容（`BrowserExtraction.ts`）→ `electron/` → `engines/` →
`cdp/`、`session/`、`workspace/` → `policies/` 与 `BrowserComposition.ts`。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下。
操作只经端口碰运行时，不直接 import 它；Electron 只许在 `impl/electron/`、`utils/electron/` 与 `types/electron.ts` 里 import。

**常量分四处。** 对外承诺的（错误码、写进声明的上限、偏好闭集、跨层标记）在 `contract/constants.ts`，声明里写给模型的数字与它由验收核对一致；
单元内可调的（超时、缓冲、保留条数、截图压缩）在 `utils/tuning.ts` 的 `BrowserTuning`；某个类里固定用的名单写成该类的 `private static readonly`；规则本身的数据跟着规则写。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。
`contract/` 的三个文件改了等于改对外契约，要在差量报告里点名。
