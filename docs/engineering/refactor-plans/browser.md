# packages/browser 按仓库标准改造方案

> 对象：`~/Desktop/VelarOS/projects/VelarOS-Platform/packages/browser`（`@velaros-ai/browser` 0.2.20）。分析期间 main 从 `da737f17` 走到 `7c39d5c9`（新增 platform 的 `isPathTextInside` / `relativePathTextInside` 与 core 的 `utils/RealPath`，本方案直接用它们）；browser 目录这期间没有任何改动，工作区干净。另一个实例正在把 agent 搬进五目录（未提交），本方案不碰 agent，但第 6 步要等 agent 的入口收口。
> 标准：`docs/architecture/module-ownership.md`、ADR 0003 / 0004 / 0005 / 0007 / 0008、门禁 `scripts/ownership/check-module-ownership.mjs` 与登记表、样板 system / project / shell-command / rehearsal-sandbox，以及流水账里已定的事（工具面判据「别的工具替代得了、只剩仪式感才删」、模型看到的文字统一中文、公共件去处、agent 入口收成 `.`/`./contracts`/`./chat`/`./tool-contract`）。
> 方法：只读。数字全部来自草稿区 `plan-browser/scripts/` 的脚本实测：TypeScript AST 加类型检查器把每个 import 穿过 barrel 解析到声明文件；工具面是 import 源码后导出的真实描述与 JSON schema（`tools-dump.json`）；消费方扫描覆盖 Platform 仓与 Desktop、Workbench、Termel、Extension，跳过 node_modules、dist、out、release、artifacts；4 个缺陷用草稿区脚本直接调源码复现（`scripts/repro-*.ts`，只在草稿区建临时目录）。
> 基线：`packages/browser` 下 `bun test test`（用现有 dist）85 pass / 0 fail，19 个文件，0.29 秒。

## 0. 结论先行

1. **规模**：`src/` 123 个文件（121 个 `.ts`/`.tsx` 加 2 个 `.d.ts`），37,061 行，四个切片：core 59 个文件 / 17,048 行、tools 47 / 10,900、runtime 13 / 8,779、composition 3 / 333。49 个类（1 个错误类）只有 4 个 `implements` 接口；472 个接口与类型别名，256 个散在实现文件里；225 个模块级函数；6 个入口共导出 713 个符号（值 172 个，其中 42 个是类），被消费方用到的 192 个（值 46 个）。模型面 40 个工具（常驻 6 个），说明加 schema 约 5.0 万字符，常驻的 6 个每轮约 1.7 万字符，其中 `browser:act` 一个就 1.1 万。
2. **主要问题**
   - **工具面**：21 个「影子工具」——用 `defineBrowserTool` 完整定义了说明、示例、schema 乃至 guided 面，却从不交给模型，只被 act / extract / recipe 的 execute 直接调（1,632 行）；公开的 40 个里 10 个 execute 超过 4 句；6 个 preset 面在任何运行档下都选不到；`export_page` 的 8 种导出有 7 种和别的工具重复；诊断四件套是同一份数据的四种过滤；提示词有 6 处与实现相反或互相冲突（`files` 读文件「必须传 endLine 或 maxChars」、上传「可传绝对路径」、网络响应体与网络控制「仅外部 CDP 浏览器」、诊断 `limit` 的含义、`read_page_data`「切到 direct/expert」、截图该用哪个工具）。
   - **实现层**（第 5 节，11 条，4 条已用脚本复现）：提取信封 bug 仍在 main（修复在未合并分支 `fix-browser-extract-save` 的 10f3f726），表格静默截到 100 行、正文超 2 万字符整份丢；点击失败后的坐标恢复会把零尺寸元素点到 (0,0) 并报 `matched: true`；用户脚本 `update` 先写代码再校验，校验失败时已启用的脚本会跑没经确认的新代码；上传与引擎落盘只做字面路径包含，站点工作区里的符号链接能把读写带出去；内嵌页面的网络采集惰性建立，第一次网络操作之前 `list_network_events` 恒为空。
   - **结构**：没有 contract / types / impl / utils / exports 分层；零件整片出包（`./core` 一个入口 408 个符号），Desktop 与 Workbench 各写 800–1,200 行宿主适配把零件拼成工具要的端口，Desktop 还另存一份 431 行的 `ToolBrowserRuntimeApi` 镜像 `ElectronBrowserRuntime`；mod 清单写死「浏览器工具客居 project 空间」；包内重复（recipe 路径两套规则、同源判定两份、诊断汇总两份、`clampInteger` 两份、`BrowserExternalPageLauncher` 接口两份）；React 合成是 `.tsx`，门禁看不见。
3. **目标**：`src/` 收成五个目录。工具文件 `impl/BrowserTools.ts` 放全部工具与分组、挂载（约 3,000 行，大头是 act 17 个动作的 schema，按标准「一个职责不拆」）；impl 7 个域子目录加 2 个根文件，41 个类文件；14 个无状态的页面脚本构建器改成 `utils/page-scripts/` 的纯函数、门面删掉；types 11 个文件，`types/browser.ts` 是可移植数据；入口从 6 个收成 4 个：`.`（Node 宿主）、`./contracts`（可移植数据）、`./renderer`（渲染进程：地址栏、偏好、截图选项、React 合成）、`./electron`（Electron 运行时，要 electron peer）。
4. **要拍板的 14 项**在第 7 节。产品层的大头：工具面 40 → 32（删 3、并 5，另可选再并 2）；`CdpBrowserRuntime` 删还是补（零消费、没验证、`enter_site` 在它上面必失败）；「客居 project 空间」改由宿主声明；是否给 `ElectronBrowserRuntime` 加 `bindToolApi` 让两个宿主删掉适配层；未合并的提取修复分支先并；用户脚本的高风险操作走审批端口；性能引擎 2.5 MB 的懒加载要门禁开一个口子。
5. **步骤**（第 6 节）：并修复分支 → 门禁与脚本准备 → 包内修缺陷、删影子工具与死代码 → 整文件搬家 → 拆混合文件、类配接口、常量四处、中文 → 工具文件与工具面简化（改提示词）→ 入口收口 0.3.0（Desktop、Workbench 同步迁移）→ 登记治理。前五步不改入口名，只删零消费的导出，Desktop、Workbench 零改动；第 6 步要排在 agent 入口收口之后。

## 1. 现状

### 1.1 目录与职责

| 目录 | 文件 | 行 | 职责 |
| --- | ---: | ---: | --- |
| `core/` | 59 | 17,048 | 宿主无关的一半：页面驱动接缝 `BrowserPageDriver`（接口文件 241 行）与 CDP 实现（`CdpBrowserPageDriver` 2,098 行、`CdpWebSocketTransport`、`CdpExternalBrowserLauncher` 672 行，负责拉起 Chrome 并读 `DevToolsActivePort`）；三个 CDP 引擎核（交互 1,014、页面数据 867、截图 266）；性能（`BrowserPerformanceOrchestrator`，`BrowserPerformanceTraceEngine` 懒加载 2.5 MB 的 vendor DevTools 引擎）；网络与环境模拟控制器（`BrowserCdpNetworkController` 967 行）；录屏；会话动作队列、挂起事件 broker、ref 定位表、用户活动协调；14 个页面脚本构建器加一个门面 `BrowserPageScriptBuilder`；站点工作区文件访问（559）、产物管理（357）、用户脚本存储（496）；登录墙检测片段与账本；recipe 预览与骨架；地址栏与偏好的纯策略；截图选项；共享类型 `types.ts`（1,779 行）；不依赖 Electron 的装配件 `CdpBrowserRuntime`（432） |
| `tools/` | 47 | 10,900 | 14 个 `*.tool.ts`（61 次 `defineBrowserTool`，40 个给模型）；4 个 schema 文件（`BrowserActSchema.ts` 1,112 行）；guided / preset 面与它们的 normalize；recipe 七件（计划、解析、步骤、记录、变量、路径、运行）；诊断过滤三件；observe 候选；点击失败后的坐标恢复；登录墙装饰器；工具上下文与宿主端口 `ToolBrowserApi`（`Types.ts`，50 个方法） |
| `runtime/` | 13 | 8,779 | Electron 的一半：`ElectronBrowserRuntime`（2,083 行、58 个公开成员）；会话管理（1,713：接管 WebContents、弹窗路由、权限、WebAuthn、用户活动桥）；截图引擎（1,828：`nativeImage` 裁剪、元素标注、模型图预算、差分、预览帧流）；页面等待（842）；交互与页面数据引擎（继承 core 的 CDP 版，只留内嵌分支）；WebContents 驱动（561）；诊断记录；可选 Kernel 模块 |
| `composition/` | 3 | 333 | React 合成边界（Provider 与 hook，68 行 `.tsx`）；`mod.ts`：7 个工具类别、常驻集、mod 清单与内置 mod 定义 |
| `src/`（根） | 1 | 1 | `velaros-globals.d.ts` |

### 1.2 子系统怎么串起来

- **一次工具调用（Desktop）**：agent 的 `ToolExecutor` → `browserTools[name].execute(input, ctx)` → `ctx.browser` 是宿主自己拼的 `ToolBrowserApi`（Desktop `src/mods/browser/main/context/BrowserTools.ts` 799 行：每个方法先过 `checkBrowserActionPolicy`，再进站点上下文，最外面用 `withBrowserLoginGate` 包住 inspect 与截图）→ `ElectronBrowserRuntime.<方法>(sessionId, context, options)` → `BrowserSessionActionQueue` 按会话串行 → 交互 / 页面数据 / 截图 / 性能引擎 → `kernel.getLivePageDriverSession`：外部页面走 `CdpBrowserPageDriver`，内嵌页面临时包一个 `ElectronWebContentsBrowserPageDriver` → 页面脚本（`BrowserPageScriptBuilder` 生成，经 `executeJavaScript` 或 CDP `Runtime.evaluate` 执行）→ 结果；动作结果带效果指纹，click 没命中时 `TargetActionRecovery` 截一张标注图再按坐标重点一次。
- **合并工具**：`act` 17 个动作、`extract` 4 个、`recipe` 6 个的 execute 各自 `switch`，再去调同文件里 21 个没公开的 `defineBrowserTool` 定义的 `.execute`；`files`（6 个动作）、`user_scripts`（9 个）、`performance`（4 个）、`export_page`（8 种）直接写在 execute 里。
- **挂起事件**：会话管理接住 dialog / download / permission → broker 登记、超时按缺省结算（弹窗取消、权限拒绝、下载取消）→ 宿主的回合快照 `getTurnContextSnapshot` 带计数 → `handle_*` 与 `list_pending_events` 只在快照里有对应事件时出现（`isAvailable`）。
- **登录墙**：inspect 与截图的页面脚本里内嵌检测片段 → 装饰器命中后经宿主的 `BrowserLoginGatePort` 阻塞征询用户 → 批准后重读一次。
- **站点工作区**：宿主给 `BrowserSiteContext.workspaceRoot`（写只写这里，读可以回退到 `legacyWorkspaceRoots`）；产物目录表（screenshots / extracts / pages / recipes / runs / downloads …）与 `manifest.json`；用户脚本存在宿主给的数据根。
- **recipe**：generate（inspect → 骨架 → `recipes/*.json`）→ read → run（plan → 逐步执行 → `runs/*.json`）→ rerun；Desktop 的 recipe 面板直接用 core 的预览函数和 tools 的 `runBrowserRecipeDryRun`。
- **性能**：`start_trace`（CDP Tracing）→ `stop_trace` → vendor 引擎解析出摘要与 insight；堆快照落盘。
- **无 Electron 宿主**：`CdpBrowserRuntime.bindBrowserApi()` 结构上满足 `ToolBrowserApi`（`tools/CdpBrowserRuntimeContract.ts` 编译期核），但全仓与两个产品零消费、没有测试。

### 1.3 对外入口：导出了什么、谁在用

「导出」按类型检查器解析入口得到；「被用」指至少一个消费方文件 import 了这个名字。消费方文件：Desktop 82 个（渲染进程 43、`packages/ipc` 6、主进程与脚本 28、测试 5），Workbench 13 个（渲染 5、主进程 6、测试 2）。Platform 仓里没有任何包 import browser，只有脚本与配置按路径引用（见 1.4 末尾）。Termel、Extension 零引用。

| 入口 | 源文件 | 导出（值） | 被用（值） | 消费方文件 | 判定 |
| --- | --- | ---: | ---: | --- | --- |
| `./core` | `src/core/index.ts`，53 条 `export *` | 408（119：函数 61、类 36、常量 22） | 119（19） | Desktop 15、Workbench 3 | 零件整片出包；类型用得最多，Desktop `src/main/tools/ToolBrowserTypes.ts` 一个文件 import 85 个类型来重声明运行时接口 |
| `./core/contracts` | `src/core/contracts.ts` | 242（24） | 47（14） | Desktop 55、Workbench 1 | 渲染进程的主入口；除类型外还出 13 个纯函数 |
| `./tools` | `src/tools/index.ts` | 11（3） | 7（2） | Desktop 3、Workbench 1 | `browserTools` 本身没人直接 import，宿主都经 mod 定义拿 |
| `./composition` | `src/composition/index.ts` | 7（3） | 6（2） | Desktop 3、Workbench 4 | React 合成 |
| `./composition/mod` | `src/composition/mod.ts` | 9（7） | 4（3） | Desktop 1、Workbench 3 | mod 定义与常驻集 |
| `./runtime` | `src/runtime/index.ts` | 36（16） | 9（6） | Desktop 10、Workbench 6 | `BrowserSessionManager`、`BrowserPageWaiter`、`BrowserDiagnosticsRecorder` 只被 Desktop 的 2 个测试用 |

被用到的 46 个值（另有 146 个类型名，见附录 B）：

- `./core`（19）：`BrowserUserScriptManager`（类，Desktop 1、Workbench 1）、`BrowserWorkspaceArtifactManager`（类，Desktop 2）、`BrowserLoginGateLedger`（类，Desktop 1）、`createBrowserSiteWorkspaceFileAccess`（Desktop 3、Workbench 1）、`createBrowserWorkspaceFileAccess`、`checkBrowserActionPolicy`、`isBrowserViewNotAttachedError`、`assertSameBrowserOrigin`、`normalizeBrowserRecipePath`、`buildRecipeSkeletonPreview`、`buildBrowserPageSnapshotName`、`browserUserScriptMatchesUrl`、`BrowserWorkspaceArtifactDirectoryMap`、`getRelativePathInsideRoot`、`toPortableRelativePath`、`getBrowserSiteHost`、`getBrowserUrlCandidate`、`isLocalBrowserUrl`、`resolveBrowserSearchOrNavigationInput`。
- `./core/contracts`（14）：地址栏五个（`getBrowserSiteHost`、`getBrowserUrlCandidate`、`isLocalBrowserUrl`、`resolveBrowserNavigationInput`、`resolveBrowserSearchOrNavigationInput`，Desktop 渲染 1 个文件、Workbench 渲染 1）、偏好四个（`BrowserAutomationModes`、`BrowserSearchEngineIds`、`DefaultBrowserAutomationMode`、`DefaultBrowserSearchEngine`）加两个解析（`resolveBrowserAutomationMode`、`resolveBrowserSearchEngineId`，Desktop 主进程配置）、`buildBrowserScreenshotOptions`（Desktop 渲染 1）、`BrowserFallbackVirtualPointer`（Desktop 预览窗口）、`BrowserModId`（Desktop 3）。
- `./tools`（2）：`withBrowserLoginGate`、`runBrowserRecipeDryRun`（都只有 Desktop 1 个文件）。类型 `ToolBrowserApi`、`BrowserToolContext`、`VelaTool`、`BrowserPageState`、`BrowserLoginGatePort`。
- `./composition`（2）：`BrowserCompositionProvider`（Desktop 1、Workbench 1）、`useControlledBrowserSurface`（Workbench 1）。
- `./composition/mod`（3）：`createBrowserBundledModDefinition`（Desktop 1、Workbench 3）、`BrowserResidentToolNames`、`BrowserModId`（Workbench）。
- `./runtime`（6）：`ElectronBrowserRuntime`（Desktop 4 个文件、Workbench 6 个，各有 1 处 `new`，其余当类型用）、`createBrowserKernelModule` 与 `BrowserRuntimeCapability`（Desktop 2、Workbench 2）、`BrowserSessionManager` / `BrowserPageWaiter` / `BrowserDiagnosticsRecorder`（只有 Desktop `tests/maintained/src/main/browser/` 两个测试，216 行）。

`ElectronBrowserRuntime` 的 58 个公开成员按名字在两个宿主里搜，56 个有引用（多数被宿主的 `ToolBrowserApi` 适配层逐个转接），`capturePreviewFrame`、`attachExternalPageDriver` 两个零引用。

### 1.4 与别的包的耦合

- **agent（peer）**：22 个文件。`./tool-contract` 用 `defineToolRuntimeSpec`、`structureToolDescriptionsForCategory`、`renderParameterDescription`（14 个文件）、读取上限的 6 个 helper（`requiredResultLimit`、`refineBoundedReadInput` 等）、`ToolContractRuntimeSpec` 等类型；`./protocol` 只用 3 个类型（`ToolPermission`、`ToolCategoryDefinition`、`ToolCapabilitySchema`）；`./run-context` 用 `TurnContextSessionLedgers`（**值**，`core/BrowserActivityCoordinator.ts` 在构造时 new）与 `TurnContextAppendBus`（类型）。所以「core 切片宿主无关」只对 Electron 成立，它运行时要 agent。agent 方案第 6 步删 `./run-context`、把这对类搬进 agent 根入口，而 `scripts/capabilities/check-arch-boundaries.mjs` 的 `ConcreteAgentRuntimeImport` 禁止能力包 import agent 根入口——两边要一起定去处（见第 6.3 节）。
- **kernel**：只有 `runtime/kernel-module.ts` 用 `contracts/abi`。
- **core**：约 135 处（根入口 62、`/error` 42、`/logger` 14、`utils/TimerScope` 14、`utils/optionalWhen` 3）。
- **platform**：零依赖，但包里有两份它已经有的东西：`core/BrowserPlatformCompatibility.ts`（taskkill 规格，= `getProcessTreeKillCommandSpec`）、`core/BrowserPathContainment.ts`（路径在不在根里，= `relativePathTextInside` / `toPortablePathText`，c9564d45 刚提供）。Chrome 安装位置候选（`CdpExternalBrowserLauncher.ts:340-370`，读 `LOCALAPPDATA`、`PROGRAMFILES`）属于 ADR 0005 说的「操作系统惯例」。
- **外部**：electron（可选 peer；9 个 runtime 文件，其中 4 个值 import）、react（可选 peer，只有 composition）、`gifenc`、`zod`、vendor `devtools-performance-engine`（`BrowserPerformanceTraceEngine.ts:60` 动态 `import()`，门禁禁止动态 import）。
- **被依赖**：只有 Desktop 与 Workbench（经 `node_modules` 软链读 dist），所以包内搬家不影响它们，入口名与导出名变了才影响。
- **按路径钉住 browser 源码的仓库脚本与配置**：根 `tsconfig.json` 的 8 条 `paths`（`@velaros-ai/browser/*` 指回 `src/<切片>`）；`scripts/capabilities/capability-owners.mjs`（`entrySubpaths`、`sourceRoots`、`electronRoots: ['runtime']`）；`check-arch-boundaries.mjs:52-73`（可移植入口 `./core/contracts` 与它许可的 7 个模块）与 `:535-541`（`requirePublicTypeContracts("browser", "src/core/index.ts", "src/core/types.ts", …)`）；`check-schemas.mjs`（读 `dist/tools/schema-bundle.json`，基线 `baselines/capabilities/browser-input-schemas.json`）；`packages/browser/scripts/generate-tools-schema-bundle.mjs`（import `../src/tools/Collection`）；`scripts/capabilities/check-packed-consumers.mjs`（孤儿脚本，没有任何地方调用，里面的消费方样例 import `BrowserSessionManager` 等将不再出包）；`docs/generated/package-catalog.json`。

### 1.5 写死了别的空间或宿主知识的地方

| # | 位置 | 写死了什么 | 去处 |
| --- | --- | --- | --- |
| H1 | `composition/mod.ts:24`（`BrowserGuestSpaceIds = ['project']`）与 `:211` | mod 清单把 40 个工具都声明为 `availableInSpaces: ['browser', 'project']`：浏览器包点名了项目空间。和 ADR 0004「空间之间互不知道对方」同一类问题 | 由宿主装配时声明（`createBrowserBundledModDefinition({ guestSpaceIds })`，Desktop 的空间配方传 `['project']`），待拍板 |
| H2 | `core/types.ts:1746` 与 `tools/Types.ts` | 工具读文件的回执叫 `ProjectReadFileResult`；`WorkspaceFileEntry` / `WorkspaceWriteFileResult` / `WorkspaceFileChangeDescriptor`（带 `changeId`）是 Desktop 工作区 IPC 的形状 | 改名 `BrowserFileReadResult`、`BrowserFileEntry` 等，字段按工具真用到的收窄 |
| H3 | `Interaction.tool.ts:969`、`Recipe.tool.ts:469`、`UserScripts.tool.ts:88` 的 `usageSkillId: 'browser-automation-recipes'` | 三个工具说明末尾都指向技能 `skill:browser-automation-recipes`，而这个技能文件在 Desktop `resources/skills/browser-automation-recipes.md`；Workbench 源码里没有 | 待拍板：技能随 browser mod 贡献，或由宿主注入 `usageSkillId`，或删掉这句 |
| H4 | Desktop `BrowserTools.ts:186-636` | 浏览器动作策略的词表（`'mouse.click'`、`'network.configure'`、`'performance.trace_start'`… 约 40 个动作名与别名）写在 Desktop 的适配层里；`checkBrowserActionPolicy` 的注释却说「Browser owns its action vocabulary」。Workbench 的适配层根本不执行策略 | 词表进 `contract/constants.ts`（`BrowserActionPolicyActions`），宿主引用它；Workbench 是否执行策略待拍板 |
| H5 | 注释里的宿主细节：`types.ts:22`（「Desktop 按站点全局」）、`tools/Types.ts:30-37`（「app 的 ToolBrowserTypes.ts re-export」「浏览器 CLI(cli.ts) 用 proxy 实现」）、`tools/LoginGate.ts:40`（「Desktop 走 ApprovalPort」）、`composition/mod.ts:215-220`（`DesktopCapabilityScopeDescriptors`） | 只是注释，但卡片与接口说明里不该出现具体产品 | 改写接口说明时去掉 |
| H6 | `BrowserConfigDefaults.ts` | 产品配置的两个闭集（搜索引擎 google / bing、自动化模式 webview / external）与出厂缺省 | 属于浏览器偏好，留在本包，进常量表 |
| H7 | `runtime/BrowserSessionManager.ts` 的 `VELAROS_BROWSER_USER_ACTIVITY__` | 页面脚本与主进程之间传用户活动的 console 前缀，形似环境变量，门禁的环境变量扫描会当成未登记变量拦下 | 改成小写前缀（页面脚本与解析同在本包，改一处即可） |

可接受：`velaros-cdp-browser-` 临时目录前缀、`velaros-browser-runtime` 等品牌标记；`http://localhost:3000` 这类示例。

### 1.6 模块级可变状态

| 位置 | 状态 | 问题 | 去处 |
| --- | --- | --- | --- |
| `core/BrowserPerformanceTraceEngine.ts:35-36,136` | `let engineModulePromise`、`let i18nBootstrapped`、兼容单例 `compatibilityTraceEngine` | vendor 引擎的懒加载与 i18n 引导挂在模块上；兼容单例只服务已 `@deprecated` 的 `parseBrowserTraceEvents`（零消费） | 改成 `DevtoolsPerformanceEngine` 类的实例字段，文件末尾给出进程唯一的一份；兼容函数与单例删掉 |
| `runtime/ElectronWebContentsBrowserPageDriver.ts:46-83` | 4 个模块级 `WeakMap`（trace、录屏、环境模拟、网络采集，按 WebContents 存） | 驱动实例是每次调用临时建的，状态只能挂在模块上；多个运行时实例共享 | 新类 `ElectronDebuggerHolds`，每个运行时一份，经驱动工厂注入 |
| `tools/RecipeArtifacts.ts:227`、`RecipeReader.ts:60`、`RecipeRun.ts:259` | 三个无状态类的模块单例 | 类没有实例状态 | 并进 `BrowserRecipeOperations`，逻辑进 `utils/recipes/` |
| `composition/BrowserCompositionProvider.tsx:45` | React context | 门禁只许实现文件的模块级放日志与导出实例 | 进 `BrowserComposition` 类的实例字段 |
| `composition/mod.ts:174` | `BrowserToolCategoryByName = new Map`（加载时建一次） | 常量，可接受；按标准进常量表 | `contract/constants.ts` 的冻结表 |

### 1.7 其它结构问题

- **类与接口**：49 个类只有 `CdpBrowserPageDriver`、`CdpBrowserPageDownloadItem`、`CdpWebSocketTransport`、`ElectronWebContentsBrowserPageDriver` 4 个 `implements`；公开成员 358 个要写进类上方的接口；私有成员 521 个，其中 135 个私有方法不用 `this`（`CdpBrowserPageDriver` 23、`BrowserScreenshotEngine` 19、`BrowserCdpNetworkController` 16、`CdpPageDataEngine` 14…），按标准进 utils；公开静态成员 2 个（`CdpBrowserPageDriver.connect`、`CdpWebSocketTransport.connect`）；一个文件两个类 1 处（`CdpBrowserPageDriver.ts`）；`BrowserInteractionEngine` / `BrowserPageDataEngine` 用继承复用 CDP 版。
- **无状态类**：14 个页面脚本构建器都没有实例状态（多数只有一个 `build…Script` 公开方法），门面 `BrowserPageScriptBuilder` 18 个方法全是转发，还被当成构造参数注入每个引擎——按标准它们就是纯函数。
- **包内重复**：recipe 路径校验两套（`tools/RecipePaths.ts:6-47` 拒绝任何含 `..` 的文件名、不认反斜杠；`core/BrowserRecipePreview.ts:25-48` 先把反斜杠换成 `/` 再按段判断）；同源判定两份（`RecipePaths.isSameBrowserOrigin` 与 `BrowserRecipePreview.assertSameBrowserOrigin`）；诊断汇总两份（`tools/DiagnosticEvents.summarizeBrowserDiagnosticEntries` 与 `CdpPageDataEngine.summarizePageDiagnostics`）；`clampInteger` 两份（`BrowserRuntimeInternals` 与 `BrowserWorkspaceFileAccess`）；`BrowserExternalPageLauncher` 接口两份（`core/CdpExternalBrowserLauncher.ts:46` 与 `runtime/BrowserRuntimeTypes.ts:78`，两个入口各导出一份）；`DefaultFetchResourceMaxBytes` 两份；`runtime/BrowserRuntimeInternals.ts` 是一个中间转发（re-export core 的 7 个函数）。
- **死代码**：21 个影子工具定义与 `tools/Interaction.ts`（194 行，只给影子工具配 guided 面）；6 个 preset 面（第 4.3 节）；`core/BrowserSameViewNavigationBridge.ts`（恒返回 `'true'` 的兼容桩，只有它自己的测试用）；`parseBrowserTraceEvents`（`@deprecated`）；`CdpBrowserRuntime` 与 `CdpBrowserRuntimeContract.ts`（零消费）；`ElectronBrowserRuntime.capturePreviewFrame`、`attachExternalPageDriver`（宿主零引用）。
- **常量**：包里没有常量表，工具说明与 schema 里的数字全是字面量（公开的 40 个工具里 schema 裸数字 48 处、说明里两位以上数字 30 处）；按门禁 5b 口径散落的数字缺省约 162 处、41 个文件（`Inspection.tool.ts` 24、`Extraction.tool.ts` 13、`BrowserScreenshotEngine.ts` 11、`BrowserSessionManager.ts` 10…）。
- **门禁看不见或会拦的写法**：`.tsx` 1 个（门禁只扫 `.ts`）；动态 `import()` 1 处；`logRuntime.tag(...)` 形式的模块级日志 5 处（门禁只认 `Log.tag(`）；实现文件里声明的类型 256 个；入口通配转发 53 条；对外导出的类 42 个。
- **环境变量**：不读任何 `VELAROS_*` 变量；读 `LOCALAPPDATA`、`PROGRAMFILES`、`PROGRAMFILES(X86)` 三个系统变量找 Chrome。
- **导入环**：把每个 import 解析到声明文件后，文件级值依赖图 0 个环；切片方向是 tools → core、runtime → core、composition → core/tools，core 不引 tools。

### 1.8 模型与用户看得到的英文

按门禁 5c 口径（报错与 `message` / `suggestedNextAction` / `note` 字段）加上门禁看不见的页面脚本内文字：

| 位置 | 原文 | 谁看得到 |
| --- | --- | --- |
| `CdpWebSocketTransport.ts:121,168,195,196,226,233,240` | `CDP command timed out: …`、`CDP transport disposed.`、`unknown CDP error`、`CDP command failed: …`、`CDP transport closed.`、`CDP transport socket error.`、`Invalid CDP JSON-RPC message.` | 外部浏览器页面上任何工具失败时的模型 |
| `Interaction.tool.ts:1134`、`Extraction.tool.ts:501`、`Recipe.tool.ts:549`、`Performance.tool.ts:173,192` | `Unsupported browser:act action.` 等 5 处 | 模型（schema 已挡住，基本走不到） |
| `runtime/kernel-module.ts:35,93,104` | `Browser capability input is invalid`；两条 `reason` | 经内核调用的宿主 |
| `runtime/BrowserSessionManager.ts:1118` | `load failed with code …`（诊断条目 message） | 模型（`get_page_diagnostics`） |
| `core/BrowserCdpNetworkController.ts:658` | `unknown network error`（诊断条目） | 模型 |
| `core/BrowserElementQueryScriptBuilder.ts:156`（页面脚本内） | `Only one iframe selector hop is supported`（`selectorError`） | 模型（`query_elements`） |
| `core/BrowserExtractionScriptBuilder.ts:44`（页面脚本内） | `no table found` | 模型（`extract action=table`） |
| `core/BrowserEvaluateScriptBuilder.ts:208`（页面脚本内） | `browser evaluate timeout after …ms` | 模型（`evaluate_script` 及所有走求值通道的工具） |
| `core/BrowserRecipeSkeletonBuilder.ts:196-262` | recipe 骨架步骤标题 `Review current page`、`Fill primary field`、`Click primary action`、`Follow primary link`、`Extract alternative links`、`Review primary section` | 模型读骨架时、用户在 Desktop 的 recipe 面板里 |
| `composition/BrowserCompositionProvider.tsx:40` | `Browser composition is not installed` | 宿主开发者（渲染进程报错） |
| act 的 superRefine（`BrowserActSchema.ts:965-976`） | 把精确分支的 zod 默认报错（英文，如 `Invalid input: expected string, received undefined`）原样转给模型 | 模型；根源是全仓 zod 没有本地化，agent 方案已记为跨包问题 |

工具说明本身是中文，但夹着没必要的英文短语：「active browser site」「browser mode」「browser workspace」「browser site」「synthetic current target」「page target list」「page driver」「recipe skeleton」「artifact」「manifest」「cookie banner」等（第 4.5 节给出改后原文）。`capabilities.reason` 的英文短语（`browser page observation` 等 6 条）与 system 的先例一致，保留。

### 1.9 测试怎么组织

- `test/` 19 个文件、85 条用例、2,541 行：15 个 `.mjs` import `dist/`（其中 3 个 import `dist/runtime/BrowserInteractionEngine.js`、`dist/tools/BrowserActSchema.js` 这类不在入口里的深路径），4 个 `.ts` import `src/`；`bun run test` 先整包构建再跑。没有 `spec/`（没有不变量登记、没有验收测试）。
- 覆盖：ref 分代与自愈、坐标恢复的歧义判定、act/extract 的 schema 形状、挂起事件工具的出现条件、页面数据预设只读、登录墙装饰器、会话动作队列、导航策略、页面等待、kernel 模块、诊断记录。**没有测试**的：21 个影子工具背后的全部动作分派、`extract` 与 `export_page` 的回执形状（所以信封 bug 一直没被发现）、`files`、`recipe` 运行、用户脚本存储、产物管理、`CdpExternalBrowserLauncher`、`CdpBrowserRuntime`。
- Desktop 的 2 个测试（`BrowserSessionLifecycle.test.ts`、`BrowserWebAuthn.test.ts`，216 行）直接 new 本包的内部类，按标准应当挪进本包。

## 2. 目标布局

### 2.1 总体

```text
packages/browser/
  MODULE.md                  模块卡片（十节）
  spec/invariants.md         不变量登记（约 15 条，见 6.2 第 7 步）
  spec/acceptance.test.ts    验收测试（只经入口）
  spec/support.ts            测试共用的假宿主端口、假驱动
  test/                      实现测试：现有 19 个文件改成 import src（照 system），加上 Desktop 挪来的 2 个
  scripts/generate-tools-schema-bundle.mjs   改 import src/impl/BrowserTools.ts
  vendor/devtools-performance-engine/        不动
  src/
    contract/  provides.ts   requires.ts   constants.ts
    types/     browser.ts（可移植）+ 10 个按域的类型文件
    impl/      BrowserTools.ts、BrowserComposition.ts + 7 个域子目录（共 41 个类文件）
    utils/     tuning.ts + 根上约 27 个文件 + 4 个域子目录（page-scripts 17、cdp 4、electron 5、recipes 9）
    exports/   index.ts   contracts.ts   renderer.ts   electron.ts
    velaros-globals.d.ts、gifenc.d.ts       （.d.ts 不在门禁的源文件口径里，照 system 放 src 根）
```

### 2.2 impl/：子目录与每个类的来源

「←」左边是目标文件（文件名即类名），右边是现在的来源。★ 是新类（从模块级状态、闭包工厂或无状态单例改来）。

| 子目录 | 类文件 | 说明 |
| --- | --- | --- |
| 根 | `BrowserTools.ts` | 工具文件：全部工具定义（schema、说明、示例、权限、能力声明）、7 个类别、常驻集、内置 mod 定义；← 14 个 `*.tool.ts` 的公开定义、4 个 schema 文件、`Inspection.ts` / `PageData.ts` 的 schema 部分、`Target.ts` 的 target schema、`Capabilities.ts`、`Collection.ts`、`composition/mod.ts` |
| 根 | `BrowserComposition.ts` ★ | React 合成：Provider 与 `useControlledSurface`，context 是实例字段；用 `createElement` 写成 `.ts`；← `composition/BrowserCompositionProvider.tsx` |
| `operations/`（7） | `BrowserActOperations` ★、`BrowserInspectOperations` ★、`BrowserExtractOperations` ★、`BrowserFileOperations` ★、`BrowserRecipeOperations` ★、`BrowserSiteOperations` ★、`BrowserDevtoolsOperations` ★ | 工具背后的执行类，execute 一行交给它们：act 的 17 个动作（替掉 11 个影子工具）；observe、诊断过滤、区域截图；extract 的 4 个动作（并入修复分支的 PageExtraction，替掉 4 个影子工具）；files 的 6 个动作与 PDF 导出（← `tools/Artifacts.ts`）；recipe 的 6 个动作与给宿主的预检（← `RecipeArtifacts` / `RecipeReader` / `RecipeRun` 三个无状态类，替掉 6 个影子工具）；进站点、用户脚本的入参映射；性能与录屏 |
| `electron/`（9） | `ElectronBrowserRuntime`、`ElectronSessionManager` ← `BrowserSessionManager`、`ElectronPageWaiter` ← `BrowserPageWaiter`、`ElectronScreenshotEngine` ← `BrowserScreenshotEngine`、`ElectronInteractionEngine` ← `BrowserInteractionEngine`、`ElectronPageDataEngine` ← `BrowserPageDataEngine`、`ElectronWebContentsBrowserPageDriver`、`ElectronDiagnosticsRecorder` ← `BrowserDiagnosticsRecorder`、`ElectronDebuggerHolds` ★ ← 4 个模块级 WeakMap | Electron 运行时装配；工厂 `createElectronBrowserRuntime`、`createBrowserKernelModule` 与能力令牌 `BrowserRuntimeCapability` 写在 `ElectronBrowserRuntime.ts` 末尾（对外入口要的工厂，门禁允许） |
| `engines/`（5） | `CdpInteractionEngine`、`CdpPageDataEngine`、`CdpScreenshotEngine`、`BrowserPerformanceOrchestrator`、`DevtoolsPerformanceEngine` ★ ← `BrowserPerformanceTraceEngine` 与它的模块级懒加载状态 | 走驱动那一半的领域引擎；Electron 版继承前两个 |
| `cdp/`（7） | `CdpBrowserPageDriver`、`CdpBrowserPageDownloadItem`（从同一文件拆出）、`CdpWebSocketTransport`、`CdpExternalBrowserLauncher`、`CdpNetworkController` ← `BrowserCdpNetworkController`、`CdpTraceCollector` ← `BrowserPerformanceTracing.ts`、`CdpScreencastRecorder` ← `BrowserScreencastRecorder.ts` | CDP 协议层；两个 `static connect` 改成 launcher 里显式构造 |
| `session/`（4） | `BrowserSessionActionQueue`、`BrowserPendingEventsBroker`、`BrowserTargetRefStore`、`BrowserActivityCoordinator` | 按会话的状态：串行队列、挂起事件、ref 分代、用户活动 |
| `workspace/`（4） | `BrowserWorkspaceFileAccess`、`BrowserWorkspaceArtifacts` ← `BrowserWorkspaceArtifactManager`、`BrowserUserScriptStore` ← `BrowserUserScriptManager`、`BrowserLoginGate` ← `BrowserLoginGateLedger` 加 `tools/LoginGate.ts` 的装饰器 | 站点工作区、产物、用户脚本存储、登录墙 |
| `policies/`（4） | `BrowserAddress` ★、`BrowserPreferences` ★、`BrowserScreenshotPolicy` ★、`BrowserActionPolicy` ★ | 纯策略的门面实例（逻辑在 utils），渲染进程与主进程共用；← `BrowserAddressHelper`、`BrowserConfigDefaults`、`BrowserScreenshotPolicy`、`BrowserActionPolicy` 四个函数文件 |

合计 41 个类文件加 1 个工具文件（若保留 `CdpBrowserRuntime` 就是 42 个类文件，放 `electron/` 同层）。删掉的类：`BrowserPageScriptBuilder` 门面与 14 个脚本构建器（改纯函数）、`BrowserPlatformCompatibility`（改用 platform）、`BrowserRecipeArtifacts` / `BrowserRecipeReader` / `BrowserRecipeRunner`（并进操作类）、`BrowserCompositionError`（改按错误码）。

### 2.3 分层（从上到下；上层可以引下层与同层）

```js
layers: [
  ['BrowserTools.ts'],                      // 工具
  ['operations/'],                          // 工具背后的执行
  ['electron/'],                            // Electron 运行时装配（保留 CdpBrowserRuntime 的话也在这一层）
  ['engines/'],                             // 领域引擎
  ['cdp/', 'session/', 'workspace/'],       // 协议、会话状态、站点工作区，互不依赖
  ['policies/', 'BrowserComposition.ts'],   // 纯策略门面与 React 合成
]
```

按目标分组给现有 121 个源文件定层后核对全部值依赖，只有 2 处下层引上层，都是把函数挪进 utils 后产生的：`tools/Context.ts` 的 `createArtifactManager` new 了产物管理器（改由 `operations/` 的类创建），`tools/TargetActionRecovery.ts` 调了截图选项（改调 `utils/screenshot-options.ts`）。其余 0 处。

### 2.4 utils/

| 位置 | 文件 | 来源 |
| --- | --- | --- |
| 根 | `tuning.ts` | 全部可调数字（约 60 项，第 3.3 节） |
| 根 | `tool.ts`、`act-input.ts`、`tool-inputs.ts`、`surfaces.ts` | `defineBrowserTool` 与三个工具守卫（← `tools/Types.ts`、`Context.ts`）；act 的别名展开与分支归一（← `BrowserActSchema.ts` 的函数部分）；extract / files / recipe 的入参解析；guided 面的 normalize（← `Inspection.ts`、`PageData.ts`） |
| 根 | `address.ts`、`preferences.ts`、`screenshot-options.ts`、`action-policy.ts`、`pointer.ts` | 四个策略门面背后的纯函数（地址栏、偏好守卫、截图选项合并、策略匹配）与兜底指针 SVG |
| 根 | `diagnostics.ts`、`observe-actions.ts`、`target-recovery.ts`、`target-refs.ts`、`pending-events.ts`、`page-data-presets.ts`、`page-content.ts` | 诊断过滤与汇总（合并两份）；动作候选；坐标恢复（修 B2）；ref 解析；挂起事件轮询；read_page_data 的预设脚本；内容边界 |
| 根 | `user-scripts.ts`、`artifacts.ts`、`login-gate.ts`、`workspace-paths.ts`、`chrome-paths.ts`、`numbers.ts`、`url.ts`、`keyboard.ts`、`viewport.ts`、`performance.ts`、`gif.ts`、`errors.ts` | 各类的无状态逻辑；`workspace-paths.ts` 用 core 的 `resolveRealPath` 与 platform 的 `relativePathTextInside` 重写包含判定（修 B4）；`numbers.ts` 合并两份 `clampInteger` |
| `page-scripts/`（17） | `action-effect`、`drag`、`element-query`、`evaluate`、`extraction`、`file-upload`、`inspection`、`login-detection`、`media-sources`、`scroll`、`storage`、`page-wait`、`target-action`、`target-highlight`、`wait-for-selector`、`inference-toolkit`、`literal` | 14 个脚本构建器类（门面删掉）、登录检测片段、推断工具片段、脚本字符串字面量编码；每个构建函数上方一句中文说明 |
| `cdp/`（4） | `driver.ts`、`network.ts`、`emulation.ts`、`tracing.ts` | CDP 驱动与网络控制器里 39 个不用 `this` 的私有方法、环境模拟、trace 传输与堆快照 |
| `electron/`（5） | `evaluate.ts`、`page-wait.ts`、`screenshot-image.ts`、`sessions.ts`、`kernel-input.ts` | WebContents 求值（← `BrowserWebContentsEvaluator.ts`）、等待与截图里不用 `this` 的方法、会话管理的 7 个模块函数、kernel 入参解析 |
| `recipes/`（9） | `parser.ts`、`paths.ts`、`plan.ts`、`records.ts`、`steps.ts`、`variables.ts`、`preview.ts`、`skeleton.ts`、`run.ts` | ← `tools/Recipe*.ts` 七件与 `core/BrowserRecipePreview.ts`、`BrowserRecipeSkeletonBuilder.ts`；路径校验与同源判定合成一份 |

### 2.5 types/：按域分文件

| 文件 | 放什么 | 出不出包 |
| --- | --- | --- |
| `browser.ts`（可移植） | 经宿主端口与 IPC 流动的全部数据：站点上下文、页面检查、动作选项与回执、截图产物、网络与诊断、挂起事件、用户脚本记录与请求、recipe 骨架 / 预览 / 预检、产物清单、预览帧、视口、偏好闭集派生类型、`ControlledBrowserSurfaceInput` 等（← `core/types.ts` 约 1,500 行，改名 `Project*` / `Workspace*` 六个） | 整个随 `./contracts` |
| `driver.ts` | 页面驱动方法的选项与回执（← `core/BrowserPageDriver.ts` 的 24 个接口里除驱动本身外的） | 注入面用到的出包 |
| `runtime.ts` | 引擎与运行时之间的内核面 `BrowserPageDriverKernel`、外部页面会话、回合上下文源（带函数成员，所以不能在可移植文件里） | 公开签名用到的出包 |
| `electron.ts` | 会话状态、权限请求、WebAuthn 请求（← `runtime/BrowserRuntimeTypes.ts`；只 `import type` electron） | 同上 |
| `cdp.ts`、`session.ts`、`workspace.ts`、`recipes.ts`、`tools.ts`、`performance.ts`、`scripts.ts` | 各域的工作类型：CDP 事件与传输、队列与 broker 条目、文件访问与产物、recipe 计划与记录、工具入参与过滤结果、trace 记录与 vendor 模块类型、脚本构建选项 | 多数留在包内 |

### 2.6 exports/：四个入口

| 入口 | 给谁用 | 里面有什么 | 为什么单开 |
| --- | --- | --- | --- |
| `.` | Node 宿主（两个产品的主进程、测试） | 工具集合与内置 mod、工作区文件访问 / 产物 / 用户脚本存储 / 登录墙 / recipe 的工厂与实例、四个策略实例、`./electron` 与 `./renderer` 里全部公开接口的**类型** | 标准入口 |
| `./contracts` | 任何进程 | 常量表加 `types/browser.ts` | 标准入口；Desktop 渲染进程 43 个文件、`packages/ipc` 6 个只要类型与常量 |
| `./renderer` | 渲染进程（要值的只有 Desktop 渲染 3 个文件、Workbench 渲染 3 个文件） | `browserAddress`、`browserPreferences`、`browserScreenshotPolicy`、`browserComposition` | 渲染进程要这几个**值**，而根入口会带进 node:fs（工作区访问、CDP 启动器）；可移植入口按标准只许常量与类型。React 是可选 peer，只在这里出现 |
| `./electron` | 两个产品的 Electron 主进程 | `createElectronBrowserRuntime`、`createBrowserKernelModule`、`BrowserRuntimeCapability` | 值 import `electron`（可选 peer）；放进根入口会让不装 Electron 的 Node 宿主一加载就失败 |

门禁的入口名映射成 `exports/<名>.ts`，名字里不能带 `/`，所以 `./core/contracts`、`./composition/mod` 这类子路径不能原样保留。`browserSafeEntries` 登记 `contracts.ts`、`renderer.ts`。按门禁规则，产品面与注入面的每个接口都要从根入口导出——包括 `ElectronBrowserRuntimeApi`、`BrowserCompositionApi` 这类只有类型的：根入口只 `export type`，运行时不会加载 electron 与 react；但根入口的声明文件会引用它们的类型（风险与处理见 6.3）。

## 3. 合同草案

原则照 ADR 0003 / 0007 与 system、project 的先例：宿主拿到的是整件能力，不是零件；类实现的 API 写在类上方、`provides.ts` 登记；出包的值只有常量表和按公开接口标注类型的实例或工厂。判定口径：**有消费方的才进产品面**，每一行写了证据；只被 Desktop 拿来自己拼装、包里已经能整件给出的，改给整件。

### 3.1 `contract/provides.ts`：产品面

| 公开接口 | 实现（impl） | 出包的值 | 成员（按消费方收窄后） | 谁在用 |
| --- | --- | --- | --- | --- |
| `BrowserToolCollection`（元素 `VelaTool`） | `BrowserTools.ts` | `browserTools` | 按工具名索引的全部工具 | 两个宿主经 mod 定义拿；标准要求出包 |
| `BrowserBundledModDefinition` | `BrowserTools.ts` | `createBrowserBundledModDefinition(options?)` | `id`、`specifier`、`defaultEnabled`、`manifest`、`bindings.{tools, toolCategories}`；`options.guestSpaceIds`（待拍板 7-6） | Desktop 1、Workbench 3 |
| `BrowserWorkspaceFileAccessApi` | `workspace/BrowserWorkspaceFileAccess` | `createBrowserSiteWorkspaceFileAccess(context)`、`createBrowserWorkspaceFileAccess(root)` | `listFiles`、`readFile`、`readWorkspacePath`、`writeFile`、`writeBinaryFile`、`deleteFile`（现有 6 个公开方法全有人用） | Desktop 4、Workbench 1 |
| `BrowserWorkspaceArtifactsApi` | `workspace/BrowserWorkspaceArtifacts` | `createBrowserWorkspaceArtifacts(store)` | `ensureManifest`、`getManifest`、`listArtifacts`、`writeArtifact`、`savePageSnapshot`（名字缺省时自己按 URL 与标题取，替掉 `buildBrowserPageSnapshotName`）、`saveRecipeSkeleton`（现有 6 个） | Desktop 2 |
| `BrowserUserScriptStoreApi` | `workspace/BrowserUserScriptStore` | `createBrowserUserScriptStore(store)` | `getOverview`、`readScript`、`createScript`、`updateScript`、`setScriptEnabled`、`setGlobalEnabled`、`moveScript`、`deleteScript`、`listRunnable`、`recordRun`（现有 10 个），加 `matchesUrl`（替掉 `browserUserScriptMatchesUrl`） | Desktop 1、Workbench 1 |
| `BrowserLoginGateApi` | `workspace/BrowserLoginGate` | `createBrowserLoginGate(port)` | `wrap(api: BrowserToolApi): BrowserToolApi`；账本是实例字段，一个浏览器会话一个实例（替掉 `withBrowserLoginGate` 加 `BrowserLoginGateLedger`） | Desktop 1 |
| `BrowserRecipesApi` | `operations/BrowserRecipeOperations` | `browserRecipes` | `normalizePath`、`preview(path, content, siteUrl)`（含同源核对，替掉 `buildRecipeSkeletonPreview` + `assertSameBrowserOrigin`）、`dryRun(input, ctx)`（替掉 `runBrowserRecipeDryRun`） | Desktop 1 |
| `BrowserActionPolicyApi` | `policies/BrowserActionPolicy` | `browserActionPolicy` | `check(policy, request)` | Desktop 1 |
| `BrowserAddressApi` | `policies/BrowserAddress` | `browserAddress` | `siteHost`、`urlCandidate`、`isLocalUrl`、`resolveNavigationInput`、`resolveSearchOrNavigationInput`、`searchFallbackUrl` | Desktop 主进程 3、渲染 1；Workbench 主进程 1、渲染 1 |
| `BrowserPreferencesApi` | `policies/BrowserPreferences` | `browserPreferences` | `resolveAutomationMode`、`resolveSearchEngineId` | Desktop 主进程 1 |
| `BrowserScreenshotPolicyApi` | `policies/BrowserScreenshotPolicy` | `browserScreenshotPolicy` | `buildOptions(options)` | Desktop 渲染 1 |
| `BrowserCompositionApi` | `BrowserComposition` | `browserComposition`（只在 `./renderer`） | `Provider({ adapter, children })`、`useControlledSurface(input)` | Desktop 1、Workbench 2 |
| `ElectronBrowserRuntimeApi` | `electron/ElectronBrowserRuntime` | `createElectronBrowserRuntime(options, setup?)`（只在 `./electron`） | 方案 A：现有 58 个里宿主有引用的 56 个（生命周期 5、呈现 6、用户活动 4、页面操作约 41）；方案 B：加 `bindToolApi(sessionId, context, options)` 后收到约 20 个界面用的（待拍板 7-7） | Desktop 4、Workbench 6（各 1 处构造） |
| `BrowserRuntimeCapabilityService` | `electron/ElectronBrowserRuntime` | 令牌 `BrowserRuntimeCapability`、工厂 `createBrowserKernelModule(options)`（只在 `./electron`） | `runtime`，外加内核可调用的 `close_session`、`close_all_sessions` | Desktop 2、Workbench 2 |

不再出包的类（42 个）改由上表的工厂与实例给出；错误类 `BrowserCompositionError` 删掉，外面按错误码 `BrowserErrorCodes.compositionNotInstalled` 判断。`CdpBrowserRuntime` 建议删（7-5）；若保留，加一行 `CdpBrowserRuntimeApi` / `createCdpBrowserRuntime`，并补上回合快照与会话登记（B8）。

### 3.2 `contract/requires.ts`：注入面

| 注入点 | 必须 | 谁给、什么时候 | 来源 |
| --- | --- | --- | --- |
| `BrowserToolContext` | 是 | 宿主每次调工具时给：`abortSignal`、`browser: BrowserToolApi`；若 7-9 通过，加 `approval: ApprovalPort` | `tools/Types.ts` |
| `BrowserToolApi`（宿主端口，门禁 `hostPort`，字段 `ctx.browser`） | 是 | 已绑定当前会话与站点的浏览器能力。现有 50 个方法每个都有工具在调，简化后仍然都在调；`getTurnContextSnapshot` 保持可选 | ← `ToolBrowserApi` 改名（和 `ProjectToolApi` 一致，7-14）；Desktop 的 `ToolBrowserTypes.ts` 已经 re-export 它 |
| `BrowserFileStorePort` | 是 | 产物与用户脚本存储的读写口：`listFiles`、`readFile`、`writeFile`、`deleteFile`；宿主传 `BrowserWorkspaceFileAccessApi`，工具侧传宿主端口的文件方法 | 现在是两个结构相同的匿名形状（`BrowserUserScriptAccess`、产物管理器的构造参数） |
| `ElectronBrowserRuntimeOptions`、`ElectronBrowserRuntimeSetup` | 用 Electron 运行时时 | 创建时给：页面驱动工厂、外部浏览器启动器、系统指针、7 个回调（站点变化、页面就绪、视口变化、会话关闭、用户活动、权限裁决 ×2）、权限处理登记、WebAuthn 选账号；`setup.turnContextAppendBus`（现在是构造函数第二个位置参数） | `runtime/BrowserRuntimeTypes.ts`；回调参数里的 `electron.Session` 改成结构类型，避免根入口声明文件依赖 electron 类型 |
| `BrowserPageDriver`、`BrowserPageDriverFactory`、`BrowserPageDriverDownloadItem`、`BrowserSystemPointerDriver` | 否 | 扩展点：接新的浏览器后端、系统指针 | `core/BrowserPageDriver.ts` |
| `BrowserExternalPageLauncher` | 否 | 扩展点：远程浏览器或容器；只留一份 | 两份合一 |
| `BrowserLoginGatePort` | 用登录墙时 | 宿主的人工确认口；没有审批通道必须返回 `approved: false` | `tools/LoginGate.ts` |
| `BrowserCompositionAdapter`、`ControlledBrowserSurface`、`ControlledBrowserSurfaceRenderOptions` | 用 React 合成时 | 宿主给受控页面的适配器；`ControlledBrowserSurfaceInput` 是数据，进可移植类型 | `composition/BrowserCompositionProvider.tsx` |
| `CreateBrowserKernelModuleOptions` | 挂进内核时 | `runtime`、`disposeInjectedRuntime` | `runtime/kernel-module.ts` |

门禁要求端口里每个方法都有工具在调：简化后 `exportPagePdf` 由 `browser:files`（新动作 `save_pdf`）调，`evaluateScript` 仍由 `evaluate_script`、`read_page_data` 调，`getContext` 由合并后的 `get_page_state` 调，没有方法落空。

### 3.3 `contract/constants.ts` 与 `utils/tuning.ts`

`constants.ts`（对外承诺，随 `./contracts` 出包）：

| 表 | 内容 | 现在在哪 |
| --- | --- | --- |
| `BrowserToolNames` 与派生 `BrowserToolName` | 全部工具的 canonical 名字 | 散在 14 个工具文件的字符串里 |
| `BrowserToolCategoryByName` 与派生 `BrowserToolCategoryId` | 每个工具唯一的类别（7 个） | `composition/mod.ts` 的 `BrowserToolNamesByCategory` 与反向 Map |
| `BrowserResidentToolNames` | 常驻集（冻结数组；Workbench 在用） | `composition/mod.ts` 的 `Set` |
| `BrowserModId`、`BrowserSpaceId`、`BrowserKernelModuleId`、`BrowserRuntimeCapabilityId` | mod、空间、内核模块、能力身份 | `BrowserModIdentity.ts`、`kernel-module.ts` 字面量 |
| `BrowserErrorCodes`、`BrowserFailureReasons` | `compositionNotInstalled`；`viewNotAttached`（`context.reason`，替掉 `isBrowserViewNotAttachedError`）；点击失败原因 `not-found` / `not-interactable` / `covered` / `option-not-found`；通用 `AppError` 码的含义说明 | `BrowserCompositionProvider.tsx`、`BrowserViewAttachment.ts`、类型里的字面量联合 |
| `BrowserSearchEngineIds`、`BrowserAutomationModes`、`DefaultBrowserSearchEngine`、`DefaultBrowserAutomationMode` | 偏好闭集与出厂缺省 | `BrowserConfigDefaults.ts` |
| `BrowserActionPolicyActions` | 动作策略词表（新，← Desktop 适配层，7-8） | Desktop `BrowserTools.ts` |
| `BrowserWorkspaceDirectories`、`BrowserArtifactFormats` | 产物目录表与格式扩展名 | `BrowserWorkspaceArtifactManager.ts`（Desktop 用目录表） |
| `BrowserFallbackVirtualPointer` | 兜底指针外观（页面脚本与宿主预览窗口共用） | `BrowserVirtualPointer.ts` |
| 上限表（工具说明与 schema 引用） | `BrowserPageLimits`（inspect 正文 / HTML / 元素、query）、`BrowserScreenshotLimits`（视口、整页、标注、等待）、`BrowserDiagnosticLimits`、`BrowserNetworkLimits`（响应体字符）、`BrowserEvaluateLimits`（超时 3 万毫秒、结果 20 万字符）、`BrowserExtractLimits`（表格序号 50、行 2000、条目 500、页 20、正文 20 万）、`BrowserFileLimits`（列 500、深度 12、读 20 万）、`BrowserRecipeLimits`（步骤 50、正文 10 万）、`BrowserUserScriptLimits`（代码 1 MB、规则 64 条、单条 500 字符、名字 120）、`BrowserFetchLimits`（单文件 50 MB）、`BrowserWaitLimits`（等待上限 6 万毫秒）、`BrowserScreencastLimits`、`BrowserPerformanceLimits` | 工具定义里的 48 个裸数字、说明里的 30 个数字、引擎里写死的同名上限 |

不读 `VELAROS_*` 环境变量，不登记环境变量表；`VELAROS_BROWSER_USER_ACTIVITY__` 前缀改名（H7）。

`utils/tuning.ts`（`BrowserTuning`，包内可调，约 60 项，按用途分组）：会话（用户空闲窗口 1,200 毫秒、队列单动作占用上限 15 万毫秒、弹窗 / 权限 / 下载的挂起超时）、CDP（命令超时、诊断与网络记录保留条数、嵌入式网络诊断 300 条）、外部浏览器（启动超时、轮询间隔、重试次数与间隔、stderr 保留行数）、截图（模型图字节预算 96 KB 与质量阶梯、模型图与整页的尺寸上限、网络空闲缺省 700 毫秒、DOM 稳定参数）、弹窗路由（引导寿命、重试、每会话上限、窗口尺寸）、提取（翻页后等待 1,200 毫秒、坐标恢复重试间隔 300 毫秒）、录屏（帧间隔上下限、末帧停留）、列表缺省（工作区列 200 条、深度 4、媒体 40 条）、回合上下文（最近错误窗口、活动账本 60 条）。

### 3.4 要删的现有导出与替代（第 6 步的迁移表）

| 收口前 | 收口后 |
| --- | --- |
| 入口 `./core`、`./core/contracts`、`./tools`、`./composition`、`./composition/mod`、`./runtime` | 删；改用 `.`、`./contracts`、`./renderer`、`./electron` |
| `./core/contracts` 与 `./core` 的全部数据类型 | `./contracts`（名字不变）；改名六个：`ProjectReadFileResult` → `BrowserFileReadResult`、`WorkspaceFileEntry` → `BrowserFileEntry`、`WorkspaceListOptions` → `BrowserFileListOptions`、`WorkspaceWriteFileResult` → `BrowserFileWriteResult`、`WorkspaceWriteFileOptions` → `BrowserFileWriteOptions`、`WorkspaceFileChangeDescriptor` → `BrowserFileChange` |
| `getBrowserSiteHost`、`getBrowserUrlCandidate`、`isLocalBrowserUrl`、`resolveBrowserNavigationInput`、`resolveBrowserSearchOrNavigationInput`、`resolveBrowserSearchFallbackUrl` | `browserAddress.siteHost` 等（`./renderer`，根入口也有） |
| `resolveBrowserAutomationMode`、`resolveBrowserSearchEngineId`、`isBrowserAutomationMode`、`isBrowserSearchEngineId` | `browserPreferences.resolveAutomationMode` / `.resolveSearchEngineId`（守卫并进解析） |
| `buildBrowserScreenshotOptions` | `browserScreenshotPolicy.buildOptions` |
| `BrowserScreenshotDefault*` 三个、`BrowserEvaluateSimplifyMax*`、`CdpNetworkThrottlingPresets` | 不出包（可调参数 / 规则数据） |
| `BrowserUserScriptManager`（类）、`browserUserScriptMatchesUrl` | `createBrowserUserScriptStore(store)`、`.matchesUrl` |
| `BrowserWorkspaceArtifactManager`（类）、`buildBrowserPageSnapshotName`、`BrowserWorkspaceArtifactDirectoryMap` | `createBrowserWorkspaceArtifacts(store)`、`savePageSnapshot` 缺省命名、常量 `BrowserWorkspaceDirectories` |
| `createBrowserSiteWorkspaceFileAccess`、`createBrowserWorkspaceFileAccess` | 名字不变，返回 `BrowserWorkspaceFileAccessApi` |
| `withBrowserLoginGate`、`BrowserLoginGateLedger`、`BrowserLoginGateOptions` | `createBrowserLoginGate(port).wrap(api)` |
| `checkBrowserActionPolicy` | `browserActionPolicy.check` |
| `isBrowserViewNotAttachedError`、`BrowserViewNotAttachedReason` | 按 `AppError.from(error).context?.reason === BrowserFailureReasons.viewNotAttached` 判断 |
| `normalizeBrowserRecipePath`、`buildRecipeSkeletonPreview`、`assertSameBrowserOrigin`、`runBrowserRecipeDryRun` | `browserRecipes.normalizePath` / `.preview` / `.dryRun` |
| `getRelativePathInsideRoot`、`toPortableRelativePath` | 不出包；宿主用 `@velaros-ai/platform` 的 `currentPlatform.relativePathTextInside` / `toPortablePathText` |
| `ElectronBrowserRuntime`（类） | `createElectronBrowserRuntime(options, setup?)`（`./electron`），类型 `ElectronBrowserRuntimeApi`（根） |
| `createBrowserKernelModule`、`BrowserRuntimeCapability` | 名字不变，改从 `./electron` 取 |
| `BrowserSessionManager`、`BrowserPageWaiter`、`BrowserDiagnosticsRecorder`、`BrowserPermissionRequestHandler` | 不出包；Desktop 的两个测试挪进本包 `test/` |
| `BrowserCompositionProvider`、`useControlledBrowserSurface`、`BrowserCompositionError` | `browserComposition.Provider`、`browserComposition.useControlledSurface`（`./renderer`）；错误按码判断 |
| `createBrowserBundledModDefinition`、`BrowserResidentToolNames`（Set）、`BrowserModId`、`BrowserToolCategoryId` | 根入口；常驻集改冻结数组 |
| `BrowserToolCategoryDefinitions`、`BrowserToolCategoryIds`、`BrowserToolNamesByCategory` | 删（零消费；分组看 `BrowserToolCategoryByName`） |
| `ToolBrowserApi`、`ToolContext`、`VelaTool`、`BrowserToolContext`、`BrowserPageState` | `BrowserToolApi`（改名）、`ToolContext` 别名删，其余不变 |
| `./core` 其余 100 个值（33 个类、46 个函数、21 个常量）与 `./runtime` 其余 10 个值 | 零消费，不出包 |

## 4. 工具面

### 4.1 全部模型面工具（40 个）

「出现条件」来自 `isAvailable`：多数要「已进站点」（`ctx.browser.isActive()`）。「说明 / schema」是交给模型的描述字符数与 JSON schema 字符数（base 面）。常驻集 6 个（类别 core），其余在 loadable 里由 `tooling:map` 按类换入。

| 工具 | 类别 | 常驻 | 出现条件 | 做什么 | 字段（* 必填） | 说明 / schema | 建议 |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| `browser:enter_site` | session | | 始终 | 打开网址并把会话绑定到该站点工作区 | url* | 297 / 195 | 留；进常驻（7-3） |
| `browser:leave_site` | session | | 已进站点 | 退出站点模式 | 无 | 125 / 33 | 留 |
| `browser:show_page` | session | | 已进站点 | 把受控页面显示到内嵌浏览器 | 无 | 170 / 33 | 留 |
| `browser:site_context` | session | | 始终 | 看是否已进站点与站点上下文 | 无 | 161 / 33 | 并入 `get_page_state` |
| `browser:list_page_targets` | session | | 已进站点 | 列页面 target（内嵌只一个） | 无 | 287 / 33 | 留（可选并入 switch） |
| `browser:switch_page_target` | session | | 已进站点 | 切到外部浏览器的另一个标签页 | targetId* | 487 / 201 | 留 |
| `browser:space_manifest` | session | | 已进站点 | 读（并每次重写）站点工作区 manifest | 无 | 166 / 33 | 删 |
| `browser:get_page_state` | core | 是 | 已进站点 | URL、标题、加载状态、视口、最近导航错误 | 无 | 156 / 33 | 留；吸收 site_context、改为始终可用 |
| `browser:inspect_page` | core | 是 | 已进站点 | 正文、标题结构、链接、交互元素与 ref | maxTextChars、includeHtml、maxHtmlChars、maxElements | 366 / 539 | 留 |
| `browser:observe_actions` | observe | | 已进站点 | 按意图给出可执行的动作候选与回放入参 | instruction、limit、ignoreSelectors | 772 / 463 | 留；回执去重（见 4.4） |
| `browser:capture_screenshot` | core | 是 | 已进站点 | 截图存进工作区，可标注元素、等待稳定、比上一张 | path、width、height、waitForNetworkIdle、waitForDomStable、fullPage、annotateElements、compareWithPrevious | 426 / 1,414 | 留；吸收 capture_region（加 `region`） |
| `browser:capture_region` | advanced | | 已进站点 | 按 selector 或矩形截一块 | selector、x、y、width、height、path | 296 / 553 | 并入 capture_screenshot |
| `browser:query_elements` | observe | | 已进站点 | CSS selector 查元素文本、属性、target | selector*、attributes、includeHtml、limit、maxTextChars、maxHtmlChars | 403 / 863（另有 preset、guided 面） | 留；删 preset 面 |
| `browser:get_page_diagnostics` | observe | | 已进站点 | 近期 console、加载错误、网络诊断与汇总 | limit、clear | 227 / 152（另有 preset、guided 面） | 留；吸收下面三个 |
| `browser:list_console_events` | network | | 已进站点 | 诊断里只看 console | limit、clear、level、errorsOnly | 331 / 345（另有 preset、guided 面） | 并入 get_page_diagnostics |
| `browser:list_network_events` | network | | 已进站点 | 诊断里只看网络 | limit、clear、status、resourceType、failedOnly | 319 / 476（另有 preset、guided 面） | 并入 get_page_diagnostics |
| `browser:get_network_request` | network | | 已进站点 | 按 requestId 读请求与响应详情 | requestId*、includeResponseBody、maxBodyChars | 629 / 521（另有 guided 面） | 留；改提示词（B6） |
| `browser:get_network_response_body` | network | | 已进站点 | 按 requestId 读响应体 | requestId*、maxChars | 506 / 359（另有 guided 面） | 留；改提示词（B6） |
| `browser:list_page_errors` | network | | 已进站点 | 诊断里只看未处理异常 | limit、clear | 281 / 152（另有 preset、guided 面） | 并入 get_page_diagnostics |
| `browser:get_element_bounds` | observe | | 已进站点 | 第一个匹配元素的视口矩形 | selector* | 217 / 154 | 删（= `read_page_data preset=selector_box`） |
| `browser:act` | core | 是 | 已进站点 | 17 个动作：点填选、跳转、滚动、键鼠、拖拽、4 种等待、视口、缩放、网络与环境模拟 | action* 加 47 个按动作的可选字段 | 1,627 / 9,630 | 留 |
| `browser:list_pending_events` | events | | 有挂起事件 | 列弹窗、下载、权限请求 | 无 | 210 / 33 | 留 |
| `browser:wait_for_pending_event` | core | 是 | 已进站点 | 等挂起事件出现（缺省等下载） | kind、timeoutMs | 385 / 257 | 留 |
| `browser:handle_dialog` | events | | 有挂起弹窗 | 确认或取消 JS 弹窗 | eventId、accept*、promptText | 333 / 288 | 留 |
| `browser:handle_download` | events | | 有挂起下载 | 接受（存到工作区）或取消下载 | eventId、action*、savePath | 250 / 335 | 留 |
| `browser:handle_permission` | events | | 有挂起权限 | 允许或拒绝权限请求 | eventId、grant* | 227 / 189 | 留 |
| `browser:upload_file` | files | | 已进站点 | 往 file input 放工作区里的文件 | target*、filePath* | 364 / 1,013 | 留；改提示词（B4） |
| `browser:fetch_resource` | files | | 已进站点 | 带会话 cookie 下载 http(s) 资源到工作区 | url*、savePath*、referer | 439 / 400 | 留 |
| `browser:list_media_sources` | files | | 已进站点 | 列图片、视频、音频 URL 与能否直接下载 | limit、includeDataUrls、includeBlobUrls | 254 / 325 | 留（可选与下一个合并） |
| `browser:list_page_resources` | files | | 已进站点 | 列链接、iframe、媒体概览 | limit、includeIframes | 270 / 222 | 留（可选合并） |
| `browser:read_page_storage` | observe | | 已进站点 | localStorage、sessionStorage、cookie | includeLocalStorage、includeSessionStorage、includeCookies、storageScope、cookieScope、limit、maxValueChars | 311 / 1,026（另有 guided、preset 面） | 留；删 preset 面 |
| `browser:read_page_data` | observe | | 已进站点 | 14 个只读预设（标题、URL、正文、selector 各项、JSON-LD、媒体） | preset*、selector、attribute、limit、maxChars | 426 / 1,387 | 留；删 4 个重复预设 |
| `browser:evaluate_script` | advanced | | 已进站点 | 在页面里跑任意 JS | script*、mode、timeoutMs、maxResultChars | 521 / 683 | 留；回执去重（B9） |
| `browser:extract` | core | 是 | 已进站点 | 表格、列表、翻页列表、正文四种提取，可存产物 | action* 加 12 个按动作的字段 | 607 / 1,547 | 留；修 B1 |
| `browser:export_page` | files | | 已进站点 | 8 种导出：正文、截图、区域、PDF、媒体、资源、表格、快照 | kind*、format、selector、savePath、save、name、fullPage、tableIndex、maxRows | 807 / 1,110 | 删；PDF 挪进 files |
| `browser:performance` | network | | 已进站点 | trace、insight、堆快照 | action、reload、autoStopMs、insightSetId、insightName、path | 681 / 1,019 | 留 |
| `browser:screencast` | advanced | | 已进站点 | 录屏合成 GIF | action*、maxWidth、everyNthFrame、name | 337 / 477 | 留 |
| `browser:files` | files | | 已进站点 | 工作区文件列读写与标准产物、页面快照 | action* 加 15 个按动作的字段 | 895 / 1,868 | 留；加 `save_pdf`；改提示词 |
| `browser:recipe` | advanced | | 已进站点 | recipe 骨架生成、读取、执行、重跑 | action* 加 16 个按动作的字段 | 950 / 2,069 | 留 |
| `browser:user_scripts` | advanced | | 已进站点 | 站点用户脚本的增删改查、启停、立即运行 | 按 action 分 9 支 | 934 / 2,459 | 留；字段补说明、改提示词 |

合计：说明 17,450 字符、schema 32,922 字符，另有 14 个 surface 面 7,269 字符；按类别：core 6 个 16,987、files 6 个 7,967、advanced 5 个 9,279、observe 6 个 6,401、network 6 个 5,619、session 7 个 2,254、events 4 个 1,865。

### 4.2 工具文件与 execute

- **工具定义不在一个文件里**：14 个 `*.tool.ts` 共 61 次 `defineBrowserTool`，其中 40 个进 `browserTools`，21 个只在文件内被 execute 直接调用——`Interaction.tool.ts` 11 个（`perform_target_action`、`navigate_page`、`scroll_page`、`type_text`、`press_key`、`move_mouse`、`click_coordinates`、`wait_for_selector`、`wait_for_page`、`set_viewport`、`set_page_zoom`）、`Extraction.tool.ts` 4 个、`Recipe.tool.ts` 6 个，合计 1,632 行完整的说明、示例、schema，模块加载时照样校验示例、按名字写进全局示例表，但模型永远看不到。`docs/tools/README.md` 还按这些影子名字介绍工具（「六十余个工具」）。
- **execute 超过 4 句**（门禁口径，含嵌套函数）：公开的 40 个里 10 个——`export_page` 29、`act` 25、`performance` 12、`user_scripts` 11、`recipe` 10、`files` 8、`extract` 8、`observe_actions` 5、`capture_region` 5、`screencast` 5；影子工具里 `paginate_extract` 24、`wait_for_page` 16、`extract_page_content` 11。改造后全部一行交给 `operations/` 的类。
- **数字**：公开工具的 schema 里裸数字 48 处、说明里两位以上数字 30 处，全部改引 3.3 节的上限表。
- **参数说明的形状**：208 个字段都用 `renderParameterDescription` 生成「描述：…⏎⏎注意：…」的结构化模板；ADR 0004 已定参数说明直接写一句话，改掉约省 1,200 字符。`user_scripts` 的 9 支 schema 字段一个说明都没有。
- **没参数的工具**：`leave_site`、`show_page`、`site_context`、`list_page_targets`、`space_manifest`、`get_page_state`、`list_pending_events` 7 个都硬凑了「用法：调用时传空对象 / 无需参数」和示例 `{}`，ADR 0004 已定不硬凑。

### 4.3 简化候选

判据（流水账 09-15 20:05 已定）：别的工具替代得了、只剩仪式感的才删；没人用过但有独特能力的不删。

| # | 候选 | 判定 | 理由 | 影响 |
| --- | --- | --- | --- | --- |
| S1 | 删 `browser:export_page` | 删，PDF 挪进 `browser:files action=save_pdf` | 8 种里 7 种是别的工具：content / table = `extract`，screenshot = `capture_screenshot`，region = `capture_region`，media = `list_media_sources`，resources = `list_page_resources`，snapshot = `files action=save_page_snapshot`；只有 pdf 独有。它的「适合」写的是「用户要求保存页面但未指定具体工具时」——路由仪式 | Desktop `UnattendedTaskToolPolicy.ts:83` 名单 |
| S2 | 删 `browser:get_element_bounds` | 删 | 就是 `read_page_data preset=selector_box`（同一段 `getBoundingClientRect` 脚本，后者还多给 visible） | Desktop `UnattendedTaskToolPolicy.ts:72` |
| S3 | 删 `browser:space_manifest` | 删 | `enter_site` 的回执已带 `workspaceManifest`；目录表在 `files action=list_artifacts`；它还每次重写 manifest（B7） | 无 |
| S4 | `list_console_events`、`list_network_events`、`list_page_errors` 并入 `get_page_diagnostics` | 并，加 `kind`（console / network / page-error / …）与各自的过滤字段 | 四个工具读的是同一份诊断缓存，三个只是过滤；合并时顺手修 B5（先过滤后取 limit、`clear` 只清所选的种类） | Desktop `UnattendedTaskToolPolicy.ts:67-68`、技能 `debug-optimize-lcp.md:64`、`a11y-debugging.md:20`；4 → 1 |
| S5 | `capture_region` 并入 `capture_screenshot` | 并，加 `region: { selector } \| { x, y, width, height }` | 同一个宿主方法 `captureScreenshot`，只差一个 region 选项 | Desktop `UnattendedTaskToolPolicy.ts:84`、`resources/skills/a11y-debugging.md:82` |
| S6 | `site_context` 并入 `get_page_state` | 并；`get_page_state` 改成始终可用，未进站点时回 `{ active: false }` | 两个都是「看状态」；常驻的 `get_page_state` 在未进站点时反而隐身，模型只能换入 `site_context` 探测 | Workbench `InitialVisibleBrowserToolNames` |
| S7 | `read_page_data` 删 `title`、`url`、`body_text`、`media_sources` 四个预设 | 删 | 分别等于 `get_page_state`、`get_page_state`、`extract action=content`（或 inspect）、`list_media_sources` | 无 |
| S8 | 6 个 preset 面 | 删 | 没有运行档选 `preset`（compact→guided、balanced→direct、expanded→expert），guided 链里 guided 先于 preset；Desktop 的 manifest-first 只在 base 面超过 6,000 字符时才退到 preset，这 6 个工具的 base 面都不到 1,400。约 900 字符说明加 6 个 normalize 永远不生效 | 无（模型看到的不变） |
| S9 | 21 个影子工具 | 删，逻辑进 `operations/` 的类 | 不是模型面工具 | 全局示例表少 21 个假名字 |
| S10 | `list_page_targets` 与 `switch_page_target` 合成一个 | 可选 | 切换前必须先列；合成 `page_targets { targetId? }` 少一次换入 | 小 |
| S11 | `list_media_sources` 与 `list_page_resources` 合成一个 | 可选 | 后者已含媒体概览；合成 `list_resources { kind }` | 小 |
| — | `observe_actions` | 留 | 按意图排序与回放入参是 inspect 没有的；只去掉回执里三份重复的 target（`target`、`actionInput.target`、`replay.input.target`） | — |
| — | 挂起事件的 5 个、`evaluate_script`、`recipe`、`user_scripts`、`performance`、`screencast`、`fetch_resource`、`upload_file`、`read_page_storage` | 留 | 各有独有能力 | — |

结果：40 → 32（S1–S3 删 3 个，S4–S6 并掉 5 个）；可选 S10、S11 再到 30。每轮常驻仍是 6 个（`site_context` 并进来后，若 7-3 通过把 `enter_site` 放进常驻就是 7 个）。

### 4.4 提示词：冗余、冲突、重复、歧义

「原文」是模型现在看到的，「改后」是建议的原文（数字改引常量表，写成模板字符串）。

| # | 工具 / 位置 | 问题 | 原文 | 改后 |
| --- | --- | --- | --- | --- |
| P1 | `files` 的「禁止」、`action` 取值、`recursive` 用法 | **与实现相反**：agent 的 `refineBoundedReadInput` 已不再强制上限，`readBrowserWorkspaceFile` 缺省读 20 万字符；`recursive` 缺 `maxDepth` 时自动补 8 | 「读取文件必须传 endLine 或 maxChars。」「read_file：读取普通文件，必须传 endLine 或 maxChars。」「recursive=true 时必须传 maxDepth。」 | 删第一句；「read_file：读普通文件；不给 endLine、maxChars 时最多读 ${BrowserFileLimits.readChars} 字符。」「recursive：是否递归列子目录；不给 maxDepth 时用工具契约的缺省深度。」 |
| P2 | `upload_file` 用法 | **与实现相反**：`resolveWorkspaceFilePath` 对绝对路径一律报「路径必须是当前浏览器工作区内的相对路径」 | 「传 target 定位 file input；filePath 为工作区内相对或绝对路径。」 | 「传 target 定位 file input；filePath 是当前站点工作区里的相对路径，例如 downloads/report.pdf。」 |
| P3 | `get_network_request`、`get_network_response_body` 的「注意」，`act` 的 `configure_network` / `configure_emulation` 取值与 `offline` 说明 | **与实现相反**：内嵌页面驱动实现了网络控制、响应体、请求详情与环境模拟（`ElectronWebContentsBrowserPageDriver.ts:134-221`，数据引擎注释「嵌入式 webview 与外部 CDP 都经同一套网络控制」） | 「仅外部 CDP 浏览器支持；webview 模式会明确报错。」「configure_network：配置外部 CDP 浏览器网络状态。」「仅外部 CDP 浏览器支持；false 会恢复在线。」 | 「requestId 来自 browser:get_page_diagnostics 的网络事件；较早的请求可能已不在缓存里。」「configure_network：离线、加请求头、拦截或 mock 请求。」「false 恢复在线。」（并修 B6） |
| P4 | 诊断三件套的「用法」与 preset 面 | **含义不对**：`limit` 其实是「最近 N 条所有种类的诊断」再过滤，`clear` 会清掉全部种类 | 「传 limit；可用 status、resourceType 或 failedOnly 缩小范围。」「默认读取最近 50 条诊断事件后只返回网络事件。」 | 合并后（S4）：「kind 选种类；limit 是过滤之后最多返回几条；clear 只清所选种类。」 |
| P5 | `read_page_data` 的 `preset` 字段、`read_page_storage` / `query_elements` 的 preset 面 | **模型做不到**：运行档由宿主定，模型没有工具切 surface | 「需要任意 JS 时切到 direct/expert。」「需要精细上限时切到 guided/direct。」「不要用它请求 HTML 或额外属性；需要时切到 guided/direct。」 | 删；工具级「注意」里已有「需要任意 JavaScript 时改用 browser:evaluate_script」 |
| P6 | `extract` 的「禁止」 | **与其他工具冲突**：把截图、媒体、资源清单都指向 `export_page`，而 `capture_screenshot`、`list_media_sources` 各有专门工具 | 「不要用于截图、PDF、媒体或资源清单导出；这些仍用 browser:export_page。」 | 「截图用 browser:capture_screenshot；媒体与资源清单用 browser:list_media_sources。」 |
| P7 | `enter_site` 的「强制流程」 | **歧义**：点了不存在的工具名 | 「先进入目标网站，再使用 inspect、query、click、screenshot 等浏览器工具。」 | 「进入后用 browser:inspect_page 看页面、browser:act 操作页面。」 |
| P8 | `show_page`、`list_page_targets`、`space_manifest` 的「用法」 | **冗余**：未进站点时这些工具根本不出现 | 「调用前必须已有 active browser site。」 | 删 |
| P9 | `act`、`extract`、`files`、`recipe` 的「注意」 | **冗余**：实现细节，对模型没用 | 「这是 browser 页面动作的唯一公开入口；内部仍按 action 复用导航、键鼠、等待和视口控制实现。」等 4 句 | 删 |
| P10 | 7 个无参工具 | **冗余** | 「用法：调用时传空对象。」「示例：调用参数示例：{}。」 | 删（ADR 0004） |
| P11 | `list_pending_events`、`handle_*` 的「禁止」 | **放错节**：限制写成禁止 | 「不要在无 pending dialog 时调用。」（工具本来就只在有挂起弹窗时出现） | 删；`fetch_resource`、`upload_file` 的「savePath / filePath 必须位于当前 browser workspace 内」挪到参数说明 |
| P12 | `user_scripts` 的「注意」 | **歧义** | 「external CDP 与 document-start v1 会返回 unsupported，不会伪报注入成功。」 | 「外部浏览器与 runAt=document-start 暂不支持，会明确回报不支持。」 |
| P13 | `list_page_targets` 的「注意」、`switch_page_target` 的「禁止」 | **英文术语** | 「WebView 路径返回单个 synthetic current target；外部 CDP 路径尽量读取真实 page target list。」「不要在内嵌 WebView 路径使用；WebView 当前只有单个 synthetic target。」 | 「内嵌页面只返回当前这一页；外部浏览器返回它的全部标签页。」「内嵌页面只有一页，不用切换。」 |
| P14 | `site_context`、`space_manifest` | **英文术语** | 「需要判断 browser mode 是否激活或查看绑定站点信息。」「不要在 browser mode 未激活时调用。」 | 随 S3、S6 删除；合并后的 `get_page_state`：「未进站点时也能调，回 active 与站点信息。」 |
| P15 | `act`、`recipe`、`user_scripts` 的末句 | **宿主知识**（H3） | 「深度用法：当前技能目录可读取 skill:browser-automation-recipes 时先读该技能。」 | 待 7-13 |
| P16 | `observe_actions` 的回执 | **重复**：每个候选的 target 出现三次，`actionInput` 与 `replay.input` 是同一个对象 | —（回执结构） | 只留 `replay`；`preview.command` 保留 |
| P17 | `evaluate_script` 的回执 | **重复**：没截断时 `result` 与 `resultText`（缩进 JSON）是同一份内容 | —（回执结构） | 没截断时不给 `resultText`（B9） |

### 4.5 模型看得到的英文

1. 报错与回执：1.8 节表里的全部文字（CDP 传输 7 条、`Unsupported … action.` 5 条、kernel 模块 3 条、诊断条目 2 条、页面脚本内 3 条、recipe 骨架标题 6 个、合成报错 1 条）改中文；错误码、字段名、CDP 方法名照原样。
2. 工具说明里的英文短语：「active browser site」→「已进入的站点」，「browser mode」→「站点模式」，「browser workspace」→「站点工作区」，「browser site」→「站点」，「page target」→「标签页」，「synthetic target」→「当前这一页」，「page driver」→「页面驱动」，「recipe skeleton」→「recipe 骨架」，「artifact」→「产物」，「cookie banner」→「cookie 提示条」；技术名词（CSS selector、iframe、cookie、JavaScript、URL、HTML、JSON、XHR、HAR、DOM、PNG、GIF、PDF、DRM、CDP）保留。
3. zod 默认报错透给模型（act 的 superRefine）：随 agent 方案的 zod 本地化一起处理，browser 这边只要不再自己拼英文。

## 5. 实现层缺陷

读代码时顺带发现的，不求全。标「已复现」的用草稿区 `plan-browser/scripts/repro-*.ts` 直接调源码跑过（只在草稿区建临时目录）。

| # | 位置 | 现象 | 复现思路 |
| --- | --- | --- | --- |
| B1 | `tools/Extraction.tool.ts:79,154,265,383-409`；`Export.tool.ts:148-164,221`；`tools/RecipeSteps.ts:86-108`；根源 `core/BrowserEvaluateScriptBuilder.ts:121,124,195` | **提取把求值信封当载荷**（10f3f726 修了前两个文件，还在未合并分支；RecipeSteps 同病未修）：`save` 的正文分支读 `result.content`，信封上没有这个字段，所以 `extract action=content save=true`、`export_page kind=content` 永远不落盘；表格 / 列表存下来的是信封；翻页读 `pageResult.items` 恒为空，只跑一页就停、合并结果为空。更深一层：求值通道的 simplify 把数组截到前 100 项，JSON 超过 `maxResultChars`（缺省 2 万）时 `result` 直接置 null——表格缺省 `maxRows` 是 200、上限写的是 2000，实际最多 100 行，而且 `rowCount` 还报原始行数；正文 `maxChars` 缺省 5 万、上限写 20 万，超过 2 万字符就整份拿不到 | **已复现**：150 行的表格载荷经 `simplifyBrowserEvaluatedValue` 后 `{"rowCount":150,"rowsReturned":100}`。真机：任意 150 行表格页 `extract {action:'table'}` 只回 100 行；长文章 `extract {action:'content', save:true}` 不产生 extracts/ 文件 |
| B2 | `tools/TargetActionRecovery.ts:40-60,97,199-227`；页面脚本 `core/BrowserTargetActionScriptBuilder.ts:233-249,643-656` | **坐标恢复把零尺寸元素点到 (0,0) 并报成功**：元素 `display:none` 或宽高为 0 时，点击脚本回 `failureReason:'not-interactable'`；恢复逻辑只排除 `covered`，于是截一张标注图（每次还往 `artifacts/screenshots/recovery/` 落一个文件）、标注里找不到它，就退到 `querySelectorAll(css)` 唯一匹配取 `getBoundingClientRect` 中心——全 0——在视口 (0,0) 点一下，回执 `matched: true` 带 `selectorRecovery`。(0,0) 通常是站点 logo，等于把页面导航回首页，还告诉模型点成功了。同样的路径也会忽略 target 的 frame 提示，在顶层文档里找 | **已复现**：假端口里 `performTargetAction` 回 not-interactable、`evaluateScript` 回 `{found:true,centerX:0,centerY:0}`，结果 `{"matched":true,"selectorRecovery":{…"x":0,"y":0},"clicks":[{"x":0,"y":0}]}`。修法：只对 `not-found` 做恢复；bounds 兜底要求宽高大于 0 且中心在视口内；带 frame 的 target 不做恢复 |
| B3 | `core/BrowserUserScriptManager.ts:333-370`（`updateScript`） | **先写代码、后校验**：`patch.code` 在第 342 行先写盘，之后才校验 name / match / excludeMatch；校验失败抛错时，索引里的 `revision`、`enabled` 都没变，磁盘上的代码却已换成新的。已启用的脚本下次注入就跑这份没经用户确认的代码——绕开了提示词承诺的「update 修改代码或执行范围后会自动 disabled，必须重新确认后启用」。另外所有变更都是「读索引 → 改 → 整份写回」，界面与工具同时改会丢更新 | **已复现**：内存假存储里 create → 启用 → `update {code:'alert("unconfirmed v2")', match:['file:///*']}`，报「match 只支持 http/https 浏览器 match pattern。」之后 `{"enabled":true,"revision":1,"codeOnDisk":"alert(\"unconfirmed v2\")\n"}`。修法：全部字段先校验、再写代码、最后写索引；写索引失败回滚代码 |
| B4 | `core/BrowserRuntimeInternals.ts:157-184`（`resolveWorkspaceFilePath`），被 `CdpPageDataEngine.ts:671`（上传）、`:690`（PDF）、`fetchResource`、截图 / 堆快照 / trace 落盘、`runtime/BrowserPageDataEngine.ts:369` 使用 | **站点工作区有两套包含判定**：`browser:files` 走 `BrowserWorkspaceFileAccess`，按真实路径判定，符号链接出界就拒绝；引擎落盘与上传走 `resolveWorkspaceFilePath`，只做字面 `path.resolve` 加相对判断。工作区里有一个指向外面的符号链接（用户或别的空间的命令建的）时，`fetch_resource` / `handle_download` / 截图能写到工作区外，`upload_file` 能把链接指向的任意文件（例如私钥）传给网页。同一函数还拒绝一切绝对路径（与 `upload_file` 的提示词矛盾，P2），也不回退 `legacyWorkspaceRoots`（`files` 列得出来的旧文件传不上去） | **已复现**：草稿区建 `site-root/downloads → ../outside`，`resolveWorkspaceFilePath(root, 'downloads/payload.bin')` 放行（`realParent` 在 outside）；同一个链接 `createBrowserSiteWorkspaceFileAccess(...).writeFile('downloads/probe.txt')` 报「浏览器工作区写入路径不能离开当前站点目录。」修法：统一走 `@velaros-ai/core/utils/RealPath` 的 `resolveRealPath` 加 platform 的 `relativePathTextInside`（ADR 0008 公共件第 8 项刚落地的两件） |
| B5 | `Inspection.tool.ts` 三个 list 工具的 execute；`core/CdpPageDataEngine.ts:542`；`runtime/BrowserPageDataEngine.ts:337-348` | **诊断过滤的 limit 与 clear 语义不对**：`limit` 先作用在「所有种类的最近 N 条」上，再在工具里过滤种类——一个 console 刷屏的页面，`list_network_events {failedOnly:true}` 可能一条失败请求都拿不到（`networkTotal: 0`，而失败请求就在更早的诊断里）；`clear:true` 清掉的是全部种类，读一次网络事件会把 console 与页面异常一起清空。preset 面的说明写了「读取最近 50 条诊断事件后只返回网络事件」，direct / guided 面没写 | 页面先发一个 404 的 fetch，再 `console.log` 200 次；`list_network_events {limit:50, failedOnly:true}` 回 0 条。修法随 S4：引擎按种类过滤后再取窗口，`clear` 带种类 |
| B6 | `runtime/ElectronWebContentsBrowserPageDriver.ts:165-199,232-243`；提示词见 P3 | **内嵌页面的网络采集惰性建立**：只有第一次调网络控制、响应体、请求详情或等网络空闲时才 attach debugger 开始采集，`readDiagnostics` 在那之前恒回空数组。模型照提示词「先 list_network_events 找 requestId」在内嵌页面上什么都拿不到；而提示词又说内嵌页面「会明确报错」，实际是能用的，只是要先有人开采集 | Desktop 内嵌浏览器进一个会发 XHR 的站点 → `list_network_events` 回 0 条 → 调一次 `get_network_request {requestId:'x'}`（报找不到，但顺带开了采集）→ 重载页面 → 再列就有了。修法二选一（7-11）：进站点就开采集，或保持惰性但回执写明「网络采集刚开始，之前的请求没有记录，重载页面后再列」 |
| B7 | `core/BrowserWorkspaceArtifactManager.ts:101-124,137,162`；`tools/Sessions.tool.ts:209-227` | **「读」清单每次都写盘**：`ensureManifest` 每次整份重写 `manifest.json`（刷新 `lastActivatedAt`），`listArtifacts`、`writeArtifact` 开头都调它；`space_manifest` 声明 `effectKind: 'read'`、`filesystem.write: 'none'`、可并发，实际每次都写 | 连续调两次 `space_manifest`，比较 manifest.json 的 mtime；两个并发的 `files action=list_artifacts` 同时整份写同一个文件。修法：只在不存在或版本不对时写；随 S3 删掉 `space_manifest` |
| B8 | `core/CdpBrowserRuntime.ts:191-297`；`tools/Context.ts:16-28` | **无 Electron 宿主上的两处断路**：`bindBrowserApi().enterSite` 只记站点上下文、不建会话，`isActive()` 看的是会话表，所以 `browser:enter_site` 自己紧接着的 `ensureManifest` 就抛「请先调用 browser:enter_site」（宿主得另外先 `registerSession`，README 的用法示例没写）；它也没有 `getTurnContextSnapshot`，而挂起事件的 4 个工具只在快照里有事件时才出现，所以这类宿主上弹窗、下载、权限永远处理不了——与 README「第三方宿主只需实现 ToolBrowserApi」相反 | 按 README 的例子 new 一个 `CdpBrowserRuntime`、`bindBrowserApi` 后调 `enter_site`。随 7-5 决定删或补 |
| B9 | `core/BrowserEvaluateScriptBuilder.ts:184-198` | **求值回执同一份内容给两遍**：没截断时 `result`（对象）与 `resultText`（`JSON.stringify(…, null, 2)` 的缩进文本，最多 2 万字符）都在，`evaluate_script`、`read_page_data`、`get_element_bounds` 每次的回执体积翻倍还多 | 读代码即可确认。修法：没截断时 `resultText` 给空串或不给；截断时才给文本 |
| B10 | `tools/Extraction.tool.ts:250-285`（翻页） | **翻页的缺省「下一页」选择器太宽**：`[class*="next"]:not([disabled])` 会匹配 class 里带 next 的任何元素（如「next-article」推荐卡片）；点击是经求值通道在页面里 `el.click()`，宿主的动作策略把它当成「执行脚本」而不是「点击」来判，也没有点击的遮挡检测与效果指纹 | 在带「下一篇」推荐链接的列表页上 `extract {action:'paginate'}` 且不给 `nextPageSelector`。修法：缺省只认 `rel=next` 与 aria 标签，点击改走宿主端口的 `performTargetAction` |
| B11 | `tools/RecipePaths.ts:6-47` 与 `core/BrowserRecipePreview.ts:25-48` | **recipe 路径两套规则**：工具侧拒绝任何含 `..` 的文件名（`recipes/a..b.json` 被拒）且不认反斜杠；Desktop 面板用的预览先把反斜杠换成 `/` 再按段判断——同一个文件面板能预览、工具读不了，或反过来 | `recipe {action:'read_skeleton', path:'recipes\\a.json'}` 被拒，而面板预览同一路径成功。修法：合成 `utils/recipes/paths.ts` 一份 |

另记两处小问题（不单列）：`tools/LoginGate.ts:63` 的注释说截图工具 `isConcurrencySafe: true`，实际是 false；`act` 的精确分支 schema 每次调用解析三遍（superRefine、overwrite、execute 里的 `parseBrowserActInput`）。

## 6. 步骤与风险

### 6.1 总体策略

先内后外：第 0–5 步只动包内，入口名不变、只删零消费的导出（`buildSameViewNavigationBridgeScript`、`parseBrowserTraceEvents` 等），Desktop、Workbench 不用改；第 6 步一次收口（破坏性，0.2.20 → 0.3.0，附 3.4 节迁移表）；第 7 步登记治理。搬家用仓库现成的 `scripts/ownership/debarrel.mjs`、`move-files.mjs`、`move-declarations.mjs`（它们改写 `packages/`、`tests/`、`scripts/` 里的相对 import）。每一步单独提交、不推送。

**每步的「全绿」口径**（下表按编号引用）：
① `bun run --cwd packages/browser typecheck`；
② `bun run --cwd packages/browser build && bun run --cwd packages/browser test:built`（现在 85 条，只许因挪位换位置、不许减；修缺陷的步骤新增用例）；
③ 根 `bun run typecheck` 与 `bun run lint`；
④ `bun run check:capabilities-schemas`（schema 基线；只有第 5 步允许 `SCHEMA_BASELINE_UPDATE=1` 重绑）；
⑤ `bun run check:capabilities-arch`；
⑥ `bun scripts/ownership/check-module-ownership.mjs --only browser`（第 1 步登记后看燃尽，其余包保持 ✓）；
⑦ `bun run check:code-style`、`bun run check:devtools-performance-engine`；
⑧ 第 3 步起加 `bun run check:package-pack`、`bun run check:package-catalog`、`bun run check:lockfile-consistency`；
⑨ 第 6 步跑整条 `bun run check`，两个产品按全链发版手册做本地发布覆盖后跑各自的 typecheck 与测试。

### 6.2 步骤

| 步骤 | 内容 | 全绿口径 | 规模 | 碰到的共享文件 |
| --- | --- | --- | --- | --- |
| **0 并修复分支**（需 7-1） | 把 `fix-browser-extract-save`（10f3f726：新增 `tools/PageExtraction.ts`，extract 与 export_page 改用它，evaluate 的结果上限提成常量，368 行测试）并进 main；同时把 `RecipeSteps` 的 extract_table / extract_list 改用同一个 helper（B1 余下的一半）。先并再搬，免得修复在搬家后重做 | ①②④（schema 不变） | 5 个文件 +649 / −155，另约 40 行 | 无 |
| **1 门禁与脚本准备**（不动 browser 源码） | 登记表加 browser 一项，`status: 'migrating'`，layers 用 2.3 节；门禁加一个口子：登记表新字段 `lazyImports`，只允许登记过的动态 import 目标（这里只有 vendor 性能引擎，7-12）；孤儿脚本 `check-packed-consumers.mjs` 删掉（它的样例消费方 import 的 `BrowserSessionManager` 第 6 步后不再出包） | `bun run check:module-ownership`（其余 5 个包仍 ✓）与 ⑥ | 3 个脚本 | `governed-modules.mjs`、`check-module-ownership.mjs`、`check-packed-consumers.mjs` |
| **2 修缺陷、删死代码**（入口不变） | 修 B2、B3、B4（`resolveWorkspaceFilePath` 改成异步、按真实路径判定，调用点跟着改）、B7、B9、B10、B11，每条带实现测试；B5、B6 的提示词部分留到第 5 步。删 21 个影子工具（act / extract / recipe 的 execute 暂时改调同文件里的普通函数，行为不变）、`tools/Interaction.ts`、6 个 preset 面（模型看到的不变）、`BrowserSameViewNavigationBridge` 与它的测试、`parseBrowserTraceEvents` 与兼容单例；`BrowserPlatformCompatibility` 改用 `@velaros-ai/platform`；若 7-5 选删，删 `CdpBrowserRuntime` 与 `CdpBrowserRuntimeContract.ts` | ①②③④⑤⑦ | 约 20 个文件，净删约 2,300 行，新增约 12 条用例 | `packages/browser/package.json`（加 platform 依赖）、`bun.lock`（工作区版本按发版手册手改） |
| **3 整文件搬家**（只搬不改，入口名不变） | 先用 `debarrel.mjs` 把 `core/index.ts` 的 53 条通配改成逐名转发；再用 `move-files.mjs` 按附录 A 的去处整文件搬：含类的进 `impl/<域>/`、纯函数进 `utils/<域>/`、纯类型进 `types/`，14 个 `*.tool.ts` 先整个进 `impl/tools/` 暂放；入口进 `src/exports/`：`core.ts`、`core-contracts.ts`、`tools.ts`、`composition.ts`、`composition-mod.ts`、`runtime.ts` 六个临时入口文件，package.json 的子路径名一个不变、只改指向；`.tsx` 改成用 `createElement` 的 `.ts`；测试里的深路径 import 改成 import src。同一提交改所有按路径钉住源码的地方 | ①②③④⑤⑦⑧ | 123 次 `git mv`，改写相对 import 约 600 处 | 根 `tsconfig.json` 的 8 条 paths；`capability-owners.mjs`（`sourceRoots`；`electronRoots` 改成 `impl/electron`、`utils/electron`、`types/electron.ts`）；`check-arch-boundaries.mjs` 两处（可移植入口许可的模块、`requirePublicTypeContracts` 的路径）；`generate-tools-schema-bundle.mjs`；`check-schemas.mjs`（若 bundle 产物路径变）；`docs/generated/package-catalog.json` |
| **4 拆文件、配接口、常量四处、中文**（入口不变） | 拆 `CdpBrowserPageDriver.ts` 的两个类；14 个脚本构建器改成 `utils/page-scripts/` 的函数、门面删掉，引擎直接调，`scripts` 构造参数删掉；135 个不用 `this` 的私有方法进 utils；41 个类全部配上方接口（现有 358 个公开成员逐个写中文说明），两个 `static connect` 改成 launcher 里显式构造；模块级状态改类（`ElectronDebuggerHolds`、`DevtoolsPerformanceEngine`）；实现文件里的 256 个类型进 `types/`；写 `contract/constants.ts` 与 `utils/tuning.ts`（3.3 节）；1.8 节的英文改中文（诊断条目、CDP 报错、recipe 骨架标题）；`logRuntime.tag` 改 `Log.tag`；`VELAROS_BROWSER_USER_ACTIVITY__` 改名 | ①②③⑤⑥（燃尽到只剩工具文件与入口两类）⑦ | 约 110 个文件；照 project 的做法按目录拆 4 路并行（engines + cdp、electron、workspace + session + policies、utils + types），各改各的目录，用临时索引提交 | 无 |
| **5 工具文件与工具面**（改提示词，差量报告逐个工具点名；入口不变） | 全部工具收进 `impl/BrowserTools.ts`（连同 7 个类别、常驻集、mod 定义；内核模块工厂在 `electron/`）；execute 一行交给 `operations/` 的 7 个类；按 7-2 做 S1–S8；4.4 节的提示词改写；参数说明改一句话，无参工具去掉用法与示例；数字改引常量表；B5，B6 按 7-11；`browser:files` 加 `save_pdf` | ①②③⑦；④ 用 `SCHEMA_BASELINE_UPDATE=1` 重绑（哈希包含参数说明，改文字就要重绑）；新增「工具表、类别、常驻集、副作用种类」的验收用例 | 工具文件约 3,000 行；工具 40 → 32 | `baselines/capabilities/browser-input-schemas.json`；产品侧名单与文案随下一次升级改：Desktop `UnattendedTaskToolPolicy.ts:67-68,72,83,84`、`resources/skills/a11y-debugging.md:20,82`、`debug-optimize-lcp.md:64`（`ContextGovernanceWiring.ts:155,188` 引用的 `observe_actions` 不变），Workbench `WorkbenchBrowserToolHost.ts` 的 `InitialVisibleBrowserToolNames`（不改也不报错，只是名单里多了不存在的工具） |
| **6 入口收口 0.3.0**（破坏性；排在 agent 入口收口之后） | `src/exports/` 换成 `index.ts`、`contracts.ts`、`renderer.ts`、`electron.ts`；provides 登记，工厂与实例标注公开接口；删 6 个旧入口与 3.4 节列出的导出；0.2.20 → 0.3.0；Desktop（82 个文件）、Workbench（13 个文件）按迁移表改：`./core/contracts` 的类型 codemod 成 `./contracts`，约 46 个值按表改；Desktop 两个测试挪进本包 `test/`；Desktop 的 `ToolBrowserTypes.ts` 改成 import `ElectronBrowserRuntimeApi`，不再自己重声明一份。7-7 若选 B，`bindToolApi` 另开一步 | ⑨ | Platform 约 20 个文件；Desktop 约 60 个；Workbench 约 13 个 | 根 `tsconfig.json`、`capability-owners.mjs` 的 `entrySubpaths`、`check-arch-boundaries.mjs`、`package-catalog.json`、`bun.lock`；包 README 与 `docs/{core,tools,runtime,composition}/README.md` 合成一份中文 README |
| **7 登记治理** | 登记表去掉 `migrating`，填 `toolsFile: 'src/impl/BrowserTools.ts'`、`toolDefiner: 'defineBrowserTool'`、`hostPort: 'BrowserToolApi'`、`hostPortField: 'browser'`、`portable: 'browser.ts'`、`tuning: 'tuning.ts'`、`browserSafeEntries: ['contracts.ts', 'renderer.ts']`、`lazyImports`（若 7-12 通过），不填 `environmentTable`；写 `MODULE.md` 十节、`spec/invariants.md`、`spec/acceptance.test.ts`、`spec/support.ts`；package.json 的 test 脚本跑验收 | `bun run check:module-ownership` 零条、`bun run check:gates` | 卡片约 250 行；不变量约 15 条 | `governed-modules.mjs` |

第 7 步的不变量草案（编号只增不重排）：同一会话有副作用的动作按到达顺序串行、不同会话并发，单个动作占住队列有上限（测试）；页面脚本不走 eval / new Function，用户脚本内联进注入源码、语法错先编译检查（测试）；ref 只对产出它的那次观察有效，新观察换代、旧 ref 明确失效不静默重绑（测试）；inspect 与截图撞上登录墙时阻塞征询用户，没有审批通道的宿主一律不放行，中止撤销记账（测试）；站点工作区的读写按真实路径判定在根内，写只写主根、读主根优先历史根只读回退（测试）；结构化提取要么完整取回、要么明确失败，不把截断结果当完整结果（测试）；CDP 路径做不到的能力明确回报不支持，不伪造结果（测试）；agent 创建的用户脚本一律停用，改代码或执行范围后自动停用，校验失败不留半截（测试）；挂起事件超时按缺省结算：弹窗取消、权限拒绝、下载取消（测试）；每个工具声明权威的副作用种类，只读工具不写盘，一个工具只属于一个类别（测试）；坐标恢复只在身份确定的唯一匹配上点击，零尺寸与不可交互元素不做坐标恢复（测试）；Electron 只在 `impl/electron/`、`utils/electron/`、`types/electron.ts` 里 import（门禁 `check:capabilities-arch`）；`./contracts`、`./renderer` 整条引用链不碰 Node 内置模块（门禁 `check:module-ownership`）；工具 schema 冻结（门禁 `check:capabilities-schemas`）。

### 6.3 风险

- **与 agent 改造交叉**：browser 从 agent 的 `./tool-contract` 取写工具的 SDK（24 个文件）、从 `./protocol` 取 3 个类型、从 `./run-context` 取 `TurnContextSessionLedgers`（值）。agent 方案第 6 步删 `./run-context`、把这对类搬进 agent 根入口，还在考虑把工具契约拆成 `@velaros-ai/tool-contract`；而 `check-arch-boundaries.mjs` 的 `ConcreteAgentRuntimeImport` 禁止能力包 import agent 根入口。所以 browser 第 6 步必须排在 agent 第 6 步之后，`TurnContextSessionLedgers` 的去处两边一起定：要么 agent 从工具契约那一侧给出，要么 browser 改由宿主经 `ElectronBrowserRuntimeSetup` 注入回合上下文账本（browser 就不再运行时依赖 agent 的实现）。前 5 步不受影响。
- **并行实例**：另一个实例正在搬 agent（大量未提交改动）；按已有做法用临时索引加暂存集硬闸提交，不用 stash；第 4 步的 4 路并行同样各用临时索引。Desktop、Workbench 各有约 45 个未提交文件，第 6 步的产品侧改动要等它们落定或在隔离 worktree 里做。
- **根入口声明文件带出 electron / react 类型**：门禁要求产品面、注入面的每个接口都从根入口导出，根 `.d.ts` 就会出现 `ElectronBrowserRuntimeApi`、`BrowserCompositionApi` 等。没装 electron、`@types/react` 且 `skipLibCheck: false` 的消费方会报类型错。处理：合同里只用结构类型（`webContentsId: number`、权限处理登记回调里的 session 用 `unknown`），不 `import type` electron；React 只用 `ReactNode` / `ReactElement`。
- **渲染进程安全**：`./renderer` 的值引用链只能到四个策略门面、`BrowserComposition` 与它们用的 utils，`workspace-paths.ts`（用 fs）等必须分文件；门禁第 7 条机械核对。
- **React 的写法**：Provider 改成 `browserComposition.Provider`（JSX 成员表达式），hook 改成 `browserComposition.useControlledSurface`；`react-hooks/rules-of-hooks` 对成员调用同样按 `use` 前缀识别，Desktop、Workbench 的 lint 不受影响。
- **schema 基线**：参数说明改一句话会改变几乎全部工具的 schema 哈希，集中在第 5 步一次重绑，差量报告逐个工具列出。
- **性能引擎**：若 7-12 不开口子而改静态 import，根入口一加载就读 2.5 MB 的 vendor 引擎，Desktop 主进程启动变慢；若拆出单独入口，又多一个入口。
- **行为变化**（差量报告点名）：B2 有的点击从「假成功」变成如实失败；B3 update 失败不再留半截；B4 越界的符号链接写入与上传从成功变成拒绝，上传的历史根回退变成可用；B5 过滤后再取窗口、`clear` 只清所选种类；B6 取决于 7-11；B7 读不再写盘。
- **旧会话**：删掉的 8 个工具在旧会话里的卡片按名字渲染，名字留着不影响；旧会话里的模型不能再调它们（与 system、project 删工具时一样）。

## 7. 需要你拍板的项

| # | 事项 | 选项 | 我的建议 | 影响谁 |
| --- | --- | --- | --- | --- |
| 7-1 | 未合并的提取修复分支 `fix-browser-extract-save`（10f3f726）并不并；并的话 RecipeSteps 同病一起修 | 并 / 不并 | 并，作为第 0 步：它修的是「save 从不落盘、表格只回 100 行、长文整份丢」，搬家之后再并要重做 | extract、export_page 的回执形状变成载荷本身（不再是信封），超限明确报 `EXECUTION_FAILED` |
| 7-2 | 工具面 40 → 32（4.3 节 S1–S8）：删 `export_page`（PDF 挪进 `files action=save_pdf`）、`get_element_bounds`、`space_manifest`；诊断四合一；`capture_region` 并入 `capture_screenshot`；`site_context` 并入 `get_page_state`；`read_page_data` 删 4 个重复预设；删 6 个 preset 面。可选 S10、S11 再到 30 | 全做 / 部分做 | 全做 S1–S8；S10、S11 先不做 | 模型面；Desktop 的无人值守名单与两个调试技能（a11y、LCP）的文案，Workbench 的初始可见名单 |
| 7-3 | `browser:enter_site` 放进常驻集 | 放 / 不放 | 放：常驻的 6 个在未进站点时全部隐身，模型要先经 `tooling:map` 换入 `enter_site`；Workbench 已在宿主侧自己补了这两个工具 | 每轮多约 500 字符 |
| 7-4 | 提示词改写（4.4 节 P1–P17）与 ADR 0004 的描述形状（参数说明一句话、无参工具不写用法和示例） | 照做 / 逐条定 | 照做；P1–P6 与实现相反或互相冲突，必须改 | 模型面；schema 基线重绑 |
| 7-5 | `CdpBrowserRuntime`（432 行）：零消费、没测试、注释自称「未经完整浏览器旅程电池验证」，`enter_site` 在它上面必失败，挂起事件的 4 个工具永远不出现（B8） | 删 / 补齐后作为公开的无 Electron 运行时 | 删（git 里可找回）；README「第三方宿主只需实现 ToolBrowserApi」随之改成宿主自己实现端口 | 对外契约；README |
| 7-6 | 「浏览器工具客居 project 空间」写在 browser 的 mod 清单里（H1） | 保留 / 改由宿主传 `guestSpaceIds` | 改由宿主传；Desktop 的空间配方传 `['project']`，行为不变 | `createBrowserBundledModDefinition` 的签名；Desktop、Workbench 装配各一行 |
| 7-7 | `ElectronBrowserRuntime` 的产品面 | A：原样 56 个成员，两个宿主的适配层不动；B：加 `bindToolApi(sessionId, context, { actionPolicy, loginGate, … })` 直接给出工具要的端口，产品面收到约 20 个界面用的成员，Desktop 删掉 `BrowserTools.ts` 的大部分与 `ToolBrowserTypes.ts`，Workbench 删掉 `WorkbenchBrowserToolHost.ts` 里的适配 | 先 A（第 6 步），B 另开一步做（和 ADR 0003 让宿主改用 `createLocalSystemKernel` 同一个方向） | 对外契约；两个产品约 2,000 行 |
| 7-8 | 动作策略的词表归属，以及 Workbench 要不要执行策略 | 词表留在 Desktop / 进 browser 常量表；Workbench 执行 / 不执行 | 进常量表 `BrowserActionPolicyActions`（和 7-7 B 配合时由包里统一执行）；Workbench 是否执行由你定 | Desktop 适配层；Workbench 行为 |
| 7-9 | 用户脚本的高风险操作（启用、切到 main world、扩大 match）走审批端口，而不是只靠提示词「未经用户明确确认，不要…」 | 给 `BrowserToolContext` 加 `approval: ApprovalPort`（像 system、project）/ 维持现状 | 加审批端口：跨站自动注入的脚本等于在用户所有登录会话里跑代码 | 注入面；两个宿主要传审批端口 |
| 7-10 | 页面内容边界 `contentBoundary`（带 nonce 与来源）：只有 `extract action=content` 带、没有任何代码读它 | 删 / 所有返回页面内容的工具统一带并在提示词里说明 | 删；要做提示注入防护应在 agent 的结果中间件统一做 | 模型面回执 |
| 7-11 | 内嵌页面的网络采集时机（B6） | 进站点就开采集（内嵌页面 debugger 常驻 attach）/ 保持惰性，工具回执写明「采集刚开始，之前的请求没有记录」 | 保持惰性加回执说明；常驻 attach 对 DevTools 同时调试、页面性能都有影响 | 行为 |
| 7-12 | vendor 性能引擎 2.5 MB 的懒加载：门禁禁止动态 `import()` | 门禁加登记字段 `lazyImports` 只放行登记过的目标 / 改静态 import / 拆成单独入口 | 加登记字段（改标准，要写进 module-ownership.md 与 ADR） | 仓库标准 |
| 7-13 | 工具说明指向的技能 `skill:browser-automation-recipes` 住在 Desktop `resources/skills/`（H3） | 技能随 browser mod 贡献 / 宿主注入 `usageSkillId` / 删掉这句 | 随 browser mod 贡献（技能讲的就是本包的 act 与 recipe；mod 清单有 `skills` 轴，宿主要在 `supportedAxes` 里启用） | 提示词；Desktop 的技能目录 |
| 7-14 | 入口与命名：4 个入口（`./renderer` 放地址栏、偏好、截图选项与 React 合成，React 只在这里）或 5 个（React 单开 `./react`）；宿主端口 `ToolBrowserApi` 改名 `BrowserToolApi`；版本 0.3.0，与 agent 1.0.0 同一次升级迁移 | — | 4 个入口；改名；同一次升级 | 对外契约；Desktop 82 个文件、Workbench 13 个文件 |

## 附录 A：123 个源文件逐个去处

「去处」第一项是第 3 步整文件搬到的位置，其余是第 4、5 步拆出去的部分。「删」的都能从 git 找回。

#### `src/core/`（59 个文件）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `BrowserActionEffectScriptBuilder.ts`（37） | `utils/page-scripts/action-effect.ts` | 无状态构建器 → 纯函数 |
| `BrowserActionPolicy.ts`（109） | `impl/policies/BrowserActionPolicy.ts`（门面实例 `browserActionPolicy`）；匹配逻辑 → `utils/action-policy.ts`；请求 / 决定两个类型 → `types/browser.ts` | Desktop 在用，改成带接口的实例 |
| `BrowserActivityCoordinator.ts`（219） | `impl/session/BrowserActivityCoordinator.ts`；选项与状态类型 → `types/session.ts`；1,200 毫秒 → tuning；活动标签 → `private static readonly` | 类配接口；回合上下文账本的来源见 6.3 |
| `BrowserAddressHelper.ts`（133） | `utils/address.ts`；门面 `impl/policies/BrowserAddress.ts` | 两个产品的主进程与渲染进程都用；公共后缀名单是规则数据，跟着函数 |
| `BrowserCdpEmulation.ts`（155） | `utils/cdp/emulation.ts` | 纯函数（收 `CdpSend`）；节流预设是规则数据 |
| `BrowserCdpNetworkController.ts`（967） | `impl/cdp/CdpNetworkController.ts`；16 个不用 `this` 的私有方法与模块函数 → `utils/cdp/network.ts`；10 个接口 → `types/cdp.ts`；记录条数上限 → tuning | 类配接口 |
| `BrowserConfigDefaults.ts`（49） | 闭集与缺省 → `contract/constants.ts`；守卫与解析 → `utils/preferences.ts`；门面 `impl/policies/BrowserPreferences.ts` | 常量表与实例分开 |
| `BrowserDragTargetScriptBuilder.ts`（146） | `utils/page-scripts/drag.ts` | 纯函数 |
| `BrowserElementQueryScriptBuilder.ts`（271） | `utils/page-scripts/element-query.ts` | 纯函数；`selectorError` 改中文 |
| `BrowserEvaluateScriptBuilder.ts`（259） | `utils/page-scripts/evaluate.ts` | 纯函数；修 B9；结果上限进 `BrowserEvaluateLimits`；页面内超时文案改中文；simplify 的两个数字是算法数字，就地留说明 |
| `BrowserExtractionScriptBuilder.ts`（244） | `utils/page-scripts/extraction.ts` | 纯函数；`no table found` 改中文 |
| `BrowserFileUploadScriptBuilder.ts`（77） | `utils/page-scripts/file-upload.ts` | 纯函数 |
| `BrowserInspectionScriptBuilder.ts`（446） | `utils/page-scripts/inspection.ts` | 纯函数 |
| `BrowserKeyChord.ts`（46） | `utils/keyboard.ts` | 纯函数 |
| `BrowserLoginDetection.ts`（115） | `utils/page-scripts/login-detection.ts` | 页面脚本片段 |
| `BrowserLoginGate.ts`（127） | 账本类并入 `impl/workspace/BrowserLoginGate.ts`；消息、风险域、记录构造 → `utils/login-gate.ts` | 账本与装饰器合成一个类，工厂 `createBrowserLoginGate` |
| `BrowserMediaSourcesScriptBuilder.ts`（121） | `utils/page-scripts/media-sources.ts` | 纯函数 |
| `BrowserModIdentity.ts`（14） | `contract/constants.ts` | 身份常量 |
| `BrowserPageDriver.ts`（241） | 驱动、驱动工厂、下载项、系统指针四个接口 → `contract/requires.ts`；其余 20 个选项与回执 → `types/driver.ts` | 扩展点属于注入面 |
| `BrowserPageScriptBuilder.ts`（160） | 删 | 18 个方法全是转发；引擎直接调 `utils/page-scripts/` |
| `BrowserPageScrollScriptBuilder.ts`（62） | `utils/page-scripts/scroll.ts` | 纯函数 |
| `BrowserPageStorageScriptBuilder.ts`（74） | `utils/page-scripts/storage.ts` | 纯函数 |
| `BrowserPageWaitScriptBuilder.ts`（237） | `utils/page-scripts/page-wait.ts` | 纯函数 |
| `BrowserPathContainment.ts`（42） | 删（第 6 步前保留导出，Desktop 在用） | 改用 platform 的 `relativePathTextInside` / `toPortablePathText` |
| `BrowserPendingEventsBroker.ts`（407） | `impl/session/BrowserPendingEventsBroker.ts`；条目类型 → `types/session.ts`；三个超时 → tuning | 类配接口 |
| `BrowserPerformanceOrchestrator.ts`（310） | `impl/engines/BrowserPerformanceOrchestrator.ts`；`extractKeyMetricsFromSummary` → `utils/performance.ts` | 类配接口 |
| `BrowserPerformanceTraceEngine.ts`（196） | `impl/engines/DevtoolsPerformanceEngine.ts`（懒加载与 i18n 引导改实例字段，文件末尾一份）；兼容函数与单例删 | 模块级可变状态；动态 import 见 7-12 |
| `BrowserPerformanceTracing.ts`（257） | `impl/cdp/CdpTraceCollector.ts`；trace 传输与堆快照 → `utils/cdp/tracing.ts`；trace 类别 → `private static readonly` | 一类一文件 |
| `BrowserPlatformCompatibility.ts`（19） | 删 | 用 platform 的 `getProcessTreeKillCommandSpec` |
| `BrowserRecipePreview.ts`（145） | `utils/recipes/preview.ts`；路径与同源 → `utils/recipes/paths.ts`（与 tools 那份合一） | 包内重复（B11） |
| `BrowserRecipeSkeletonBuilder.ts`（296） | `utils/recipes/skeleton.ts` | 纯函数；步骤标题改中文 |
| `BrowserRuntimeInternals.ts`（184） | 内核面与外部会话 → `types/runtime.ts`；数字 helper → `utils/numbers.ts`；`resolveExternalPageUrl` → `utils/url.ts`；`resolveWorkspaceFilePath` → `utils/workspace-paths.ts`（重写，B4）；缺省视口 → tuning | 混合文件拆开 |
| `BrowserSameViewNavigationBridge.ts`（12） | 删（连同它的测试） | 恒返回 `'true'` 的兼容桩，零消费 |
| `BrowserScreencastRecorder.ts`（260） | `impl/cdp/CdpScreencastRecorder.ts`；GIF 合成 → `utils/gif.ts`；帧间隔 → tuning | 一类一文件 |
| `BrowserScreenshotPolicy.ts`（85） | `utils/screenshot-options.ts`；门面 `impl/policies/BrowserScreenshotPolicy.ts`；三个缺省 → tuning | Desktop 渲染在用 |
| `BrowserScriptLiteral.ts`（12） | `utils/page-scripts/literal.ts` | 纯函数 |
| `BrowserSessionActionQueue.ts`（184） | `impl/session/BrowserSessionActionQueue.ts`；占用上限 → tuning | 类配接口 |
| `BrowserTargetActionScriptBuilder.ts`（698） | `utils/page-scripts/target-action.ts` | 纯函数 |
| `BrowserTargetHighlightScriptBuilder.ts`（105） | `utils/page-scripts/target-highlight.ts` | 纯函数 |
| `BrowserTargetRefStore.ts`（253） | `impl/session/BrowserTargetRefStore.ts`；4 个不用 `this` 的方法 → `utils/target-refs.ts` | 类配接口 |
| `BrowserUserScriptManager.ts`（496） | `impl/workspace/BrowserUserScriptStore.ts`（修 B3）；15 个模块函数 → `utils/user-scripts.ts`；上限 → `BrowserUserScriptLimits` | 产品面，工厂 `createBrowserUserScriptStore` |
| `BrowserViewAttachment.ts`（27） | 原因码 → `BrowserFailureReasons`；判定函数 → `utils/errors.ts`（包内用） | 外面按码判断 |
| `BrowserViewport.ts`（30） | `utils/viewport.ts` | 纯函数 |
| `BrowserVirtualPointer.ts`（28） | 外观常量 → `contract/constants.ts`；SVG 拼装 → `utils/pointer.ts` | 渲染进程要常量 |
| `BrowserWaitForSelectorScriptBuilder.ts`（188） | `utils/page-scripts/wait-for-selector.ts` | 纯函数 |
| `BrowserWorkspaceArtifactManager.ts`（357） | `impl/workspace/BrowserWorkspaceArtifacts.ts`（修 B7）；6 个模块函数 → `utils/artifacts.ts`；目录表与格式表 → 常量表；manifest 路径与版本 → `private static readonly` | 产品面，工厂 `createBrowserWorkspaceArtifacts` |
| `BrowserWorkspaceFileAccess.ts`（559） | `impl/workspace/BrowserWorkspaceFileAccess.ts`；5 个模块函数 → `utils/workspace-paths.ts`、`utils/numbers.ts`；列表缺省 → tuning | 产品面；以后可改用 `@velaros-ai/text-files` 的有界读与原子写 |
| `CdpBrowserPageDriver.ts`（2098） | `impl/cdp/CdpBrowserPageDriver.ts` 与 `impl/cdp/CdpBrowserPageDownloadItem.ts`；23 个不用 `this` 的方法 → `utils/cdp/driver.ts`；26 个接口 → `types/cdp.ts`；`static connect` 删 | 一个文件两个类 |
| `CdpBrowserRuntime.ts`（432） | 删（7-5）；若保留 → `impl/electron/` 同层的 `CdpBrowserRuntime.ts` | 零消费 |
| `CdpExternalBrowserLauncher.ts`（672） | `impl/cdp/CdpExternalBrowserLauncher.ts`；Chrome 路径候选 → `utils/chrome-paths.ts`（或挪进 platform）；超时与重试 → tuning；测试用的依赖注入袋收掉（没有测试在用） | 类配接口；不给测试留钩子 |
| `CdpInteractionEngine.ts`（1014） | `impl/engines/CdpInteractionEngine.ts`；9 个不用 `this` 的方法 → utils；自愈权重 → `private static readonly` | 类配接口 |
| `CdpPageDataEngine.ts`（867） | `impl/engines/CdpPageDataEngine.ts`；14 个不用 `this` 的方法 → utils；诊断汇总与 tools 那份合一；落盘与上传前的路径判定改用 `utils/workspace-paths.ts` | 类配接口；B4 |
| `CdpScreenshotEngine.ts`（266） | `impl/engines/CdpScreenshotEngine.ts` | 类配接口 |
| `CdpWebSocketTransport.ts`（262） | `impl/cdp/CdpWebSocketTransport.ts`；7 条英文报错改中文；`static connect` 删 | 类配接口 |
| `browserInlineInferenceToolkit.ts`（74） | `utils/page-scripts/inference-toolkit.ts` | 纯函数 |
| `contracts.ts`（42） | `exports/contracts.ts`（只剩常量与可移植类型；函数挪 `./renderer`） | 入口 |
| `gifenc.d.ts`（29） | `src/gifenc.d.ts` | 环境声明，照 `velaros-globals.d.ts` 放 src 根 |
| `index.ts`（54） | `exports/index.ts` | 入口；53 条通配改逐名转发 |
| `types.ts`（1779） | `types/browser.ts`（可移植，约 1,500 行，改名 6 个）；`BrowserTurnContextDeltaSource` 等带函数成员的 → `types/runtime.ts` | 可移植文件不带函数成员 |

#### `src/tools/`（47 个文件）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `Artifacts.tool.ts`（77） | `impl/BrowserTools.ts`（`browser:files`） | 工具定义进工具文件 |
| `Artifacts.ts`（156） | `impl/operations/BrowserFileOperations.ts`；入参类型 → `types/tools.ts`；读缺省 → `BrowserFileLimits` | 6 个函数变成执行类方法 |
| `BrowserActSchema.ts`（1112） | schema → `impl/BrowserTools.ts`；别名展开与分支归一 → `utils/act-input.ts`；解析后的联合类型 → `types/tools.ts` | schema 是工具定义 |
| `BrowserExtractSchema.ts`（245） | 同上（`utils/tool-inputs.ts`） | 同上 |
| `BrowserFilesSchema.ts`（245） | 同上 | 同上 |
| `BrowserRecipeSchema.ts`（300） | 同上 | 同上 |
| `Capabilities.ts`（83） | 能力声明对象 → `impl/BrowserTools.ts`；三个类型 → `types/tools.ts` | 工具文件的模块级常量门禁允许 |
| `CdpBrowserRuntimeContract.ts`（17） | 删 | 随 7-5；保留的话由 `bindBrowserApi` 的返回类型标注代替 |
| `Collection.ts`（41） | `impl/BrowserTools.ts` | 分组与集合 |
| `ConsoleEvents.ts`（61） | `utils/diagnostics.ts` | 与另外三个诊断文件合一（S4） |
| `Context.ts`（63） | 守卫 → `utils/tool.ts`；`createArtifactManager` → `operations/` 的类 | 分层核对里两处「utils 引 impl」之一 |
| `DiagnosticEvents.ts`（72） | `utils/diagnostics.ts` | 同上 |
| `Events.tool.ts`（229） | `impl/BrowserTools.ts` | 工具定义 |
| `Export.tool.ts`（257） | 删（S1）；PDF 分支 → `BrowserFileOperations` | 7 种重复 |
| `Extraction.tool.ts`（509） | `browser:extract` → `impl/BrowserTools.ts`；4 个影子工具的执行 → `impl/operations/BrowserExtractOperations.ts`（含修复分支的 PageExtraction） | S9、B1 |
| `Fetch.tool.ts`（192） | `impl/BrowserTools.ts` | 工具定义 |
| `Inspection.tool.ts`（911） | `impl/BrowserTools.ts`；observe、诊断过滤、区域截图的执行 → `impl/operations/BrowserInspectOperations.ts` | execute 超 4 句的挪走 |
| `Inspection.ts`（331） | schema → `impl/BrowserTools.ts`；guided 面的 normalize → `utils/surfaces.ts`；入参类型 → `types/tools.ts` | 同上 |
| `Interaction.tool.ts`（1142） | `browser:act` → `impl/BrowserTools.ts`；11 个影子工具的执行 → `impl/operations/BrowserActOperations.ts` | S9 |
| `Interaction.ts`（193） | 删 | 只给影子工具配 guided 面 |
| `LoginGate.ts`（129） | `impl/workspace/BrowserLoginGate.ts`（与账本合成一个类）；端口 → `contract/requires.ts` | 模块级工厂改类 |
| `NetworkEvents.ts`（73） | `utils/diagnostics.ts` | S4 |
| `ObserveActions.ts`（306） | `utils/observe-actions.ts`（回执去重，P16） | 纯函数 |
| `PageContentBoundary.ts`（26） | 删或 `utils/page-content.ts`（7-10） | 没有读者 |
| `PageData.tool.ts`（211） | `impl/BrowserTools.ts` | 工具定义 |
| `PageData.ts`（402） | schema → `impl/BrowserTools.ts`；预设脚本 → `utils/page-data-presets.ts`（删 4 个重复预设） | 同上 |
| `PageErrors.ts`（31） | `utils/diagnostics.ts` | S4 |
| `PendingEvents.ts`（69） | `utils/pending-events.ts`；轮询间隔 → tuning | 纯函数（收端口接口） |
| `Performance.tool.ts`（200） | `impl/BrowserTools.ts`；执行 → `impl/operations/BrowserDevtoolsOperations.ts` | execute 12 句 |
| `Recipe.tool.ts`（557） | `browser:recipe` → `impl/BrowserTools.ts`；6 个影子工具 → `impl/operations/BrowserRecipeOperations.ts` | S9 |
| `RecipeArtifacts.ts`（229） | `impl/operations/BrowserRecipeOperations.ts`；接口 → `types/recipes.ts` | 无状态单例 |
| `RecipeParser.ts`（116） | `utils/recipes/parser.ts` | 纯函数 |
| `RecipePaths.ts`（74） | `utils/recipes/paths.ts`（与 core 那份合一，B11） | 包内重复 |
| `RecipePlan.ts`（399） | `utils/recipes/plan.ts`；类型 → `types/recipes.ts` | 纯函数 |
| `RecipeReader.ts`（62） | `impl/operations/BrowserRecipeOperations.ts` | 无状态单例 |
| `RecipeRecords.ts`（213） | `utils/recipes/records.ts`；类型 → `types/recipes.ts` | 纯函数 |
| `RecipeRun.ts`（303） | 编排 → `BrowserRecipeOperations`；可复用的步骤 → `utils/recipes/run.ts`；`runBrowserRecipeDryRun` → `browserRecipes.dryRun` | 产品面 |
| `RecipeSteps.ts`（180） | `utils/recipes/steps.ts`（第 0 步修信封） | B1 |
| `RecipeVariables.ts`（51） | `utils/recipes/variables.ts` | 纯函数 |
| `Screencast.tool.ts`（71） | `impl/BrowserTools.ts`；执行 → `BrowserDevtoolsOperations` | execute 5 句 |
| `Sessions.tool.ts`（239） | `impl/BrowserTools.ts`；进站点与 manifest → `impl/operations/BrowserSiteOperations.ts`；`space_manifest` 删（S3），`site_context` 并入 `get_page_state`（S6） | 工具定义 |
| `Target.ts`（77） | target schema → `impl/BrowserTools.ts`；`normalizeBrowserTargetHint` → `utils/tool-inputs.ts` | 同上 |
| `TargetActionRecovery.ts`（239） | `utils/target-recovery.ts`（修 B2） | 纯函数（收端口接口） |
| `Types.ts`（206） | `BrowserToolApi`、`BrowserToolContext` → `contract/requires.ts`；`VelaTool`、`BrowserToolCollection` → `contract/provides.ts`；`BrowserPageState` → `types/browser.ts`；`defineBrowserTool` → `utils/tool.ts` | 合同与类型分开 |
| `Upload.tool.ts`（63） | `impl/BrowserTools.ts` | 工具定义；提示词 P2 |
| `UserScripts.tool.ts`（123） | `impl/BrowserTools.ts`；入参映射 → `BrowserSiteOperations` | execute 11 句 |
| `index.ts`（15） | 并入 `exports/index.ts` | 入口 |

#### `src/runtime/`（13 个文件）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `BrowserDiagnosticsRecorder.ts`（64） | `impl/electron/ElectronDiagnosticsRecorder.ts`；上限 → tuning | 类配接口；Desktop 测试挪进本包 |
| `BrowserInteractionEngine.ts`（804） | `impl/electron/ElectronInteractionEngine.ts` | 类配接口（继承 CDP 版） |
| `BrowserPageDataEngine.ts`（518） | `impl/electron/ElectronPageDataEngine.ts`；诊断合并按种类过滤（B5） | 同上 |
| `BrowserPageWaiter.ts`（842） | `impl/electron/ElectronPageWaiter.ts`；8 个不用 `this` 的方法 → `utils/electron/page-wait.ts` | 类配接口 |
| `BrowserRuntimeInternals.ts`（55） | 删 | 中间转发加两个内部类型（→ `types/runtime.ts`） |
| `BrowserRuntimeTypes.ts`（104） | 选项 → `contract/requires.ts`；会话、权限、WebAuthn → `types/electron.ts`；重复的启动器接口删 | 注入面与类型分开 |
| `BrowserScreenshotEngine.ts`（1828） | `impl/electron/ElectronScreenshotEngine.ts`；19 个不用 `this` 的方法 → `utils/electron/screenshot-image.ts`；11 处数字 → tuning | 类配接口 |
| `BrowserSessionManager.ts`（1713） | `impl/electron/ElectronSessionManager.ts`；7 个模块函数 → `utils/electron/sessions.ts`；10 处数字 → tuning；活动前缀改名（H7） | 类配接口 |
| `BrowserWebContentsEvaluator.ts`（73） | `utils/electron/evaluate.ts` | 纯函数 |
| `ElectronBrowserRuntime.ts`（2083） | `impl/electron/ElectronBrowserRuntime.ts`（上方写 `ElectronBrowserRuntimeApi`，末尾两个工厂与能力令牌）；8 个不用 `this` 的方法 → utils | 产品面 |
| `ElectronWebContentsBrowserPageDriver.ts`（561） | `impl/electron/ElectronWebContentsBrowserPageDriver.ts`；4 个 WeakMap → `impl/electron/ElectronDebuggerHolds.ts`；模块工厂改运行时的方法 | 模块级状态 |
| `index.ts`（8） | `exports/electron.ts` | 入口 |
| `kernel-module.ts`（126） | 工厂 → `ElectronBrowserRuntime.ts` 末尾；入参解析 → `utils/electron/kernel-input.ts`；英文报错改中文 | 工厂随运行时 |

#### `src/composition/`（3 个文件）与 `src/` 根（1 个）

| 文件（行） | 去处 | 理由 |
| --- | --- | --- |
| `BrowserCompositionProvider.tsx`（68） | `impl/BrowserComposition.ts`（`createElement` 写成 `.ts`，context 是实例字段）；适配器接口 → `contract/requires.ts`；输入 → `types/browser.ts`；错误类删 | 门禁看不见 `.tsx` |
| `index.ts`（1） | `exports/renderer.ts` | 入口 |
| `mod.ts`（264） | 类别、常驻、清单、mod 定义 → `impl/BrowserTools.ts`；名字与类别表 → 常量表；客居空间改参数（7-6） | 工具的分组与挂载 |
| `velaros-globals.d.ts`（1） | 不动 | — |

## 附录 B：被消费方用到的类型名（按入口）

值已在 1.3 节列出；下面是其余被 import 的类型名（Desktop、Workbench 合计，括号里是引用它的文件数）。第 6 步的迁移按「数据类型进 `./contracts`（名字不变，六个改名见 3.4）、接口类型进根入口」处理。

- `./core`（100 个）：`BrowserActionPolicyConfig`（4）、`BrowserActionPolicyRequest`（1）、`BrowserCaptureScreenshotOptions`（1）、`BrowserClickCoordinatesOptions`（1）、`BrowserClickCoordinatesResult`（1）、`BrowserDragOptions`（1）、`BrowserDragResult`（1）、`BrowserElementQueryOptions`（1）、`BrowserElementQueryResult`（1）、`BrowserElementSelection`（3）、`BrowserEmulationOptions`（1）、`BrowserEmulationResult`（1）、`BrowserEvaluateScriptOptions`（1）、`BrowserEvaluateScriptResult`（1）、`BrowserExportPagePdfOptions`（1）、`BrowserExportPagePdfResult`（1）、`BrowserFetchResourceOptions`（1）、`BrowserFetchResourceResult`（1）、`BrowserHandleDialogOptions`（1）、`BrowserHandleDialogResult`（1）、`BrowserHandleDownloadOptions`（1）、`BrowserHandleDownloadResult`（1）、`BrowserHandlePermissionOptions`（1）、`BrowserHandlePermissionResult`（1）、`BrowserHeapSnapshotOptions`（1）、`BrowserHeapSnapshotResult`（1）、`BrowserInspectPageOptions`（2）、`BrowserListMediaSourcesOptions`（1）、`BrowserListMediaSourcesResult`（1）、`BrowserListPageResourcesOptions`（1）、`BrowserListPageResourcesResult`（1）、`BrowserMoveMouseOptions`（1）、`BrowserMoveMouseResult`（1）、`BrowserNavigationHistoryRestore`（2）、`BrowserNetworkControlOptions`（1）、`BrowserNetworkControlResult`（1）、`BrowserNetworkRequestDetailsOptions`（1）、`BrowserNetworkRequestDetailsResult`（1）、`BrowserNetworkResponseBodyOptions`（1）、`BrowserNetworkResponseBodyResult`（1）、`BrowserPageDiagnostics`（1）、`BrowserPageDiagnosticsOptions`（1）、`BrowserPageInspection`（1）、`BrowserPageNavigationOptions`（2）、`BrowserPageNavigationResult`（4）、`BrowserPagePreviewFrame`（1）、`BrowserPagePreviewStreamEvent`（3）、`BrowserPageScrollOptions`（1）、`BrowserPageScrollResult`（1）、`BrowserPageStorageOptions`（1）、`BrowserPageStorageResult`（1）、`BrowserPageTargetsResult`（1）、`BrowserPageWaitOptions`（1）、`BrowserPageWaitResult`（1）、`BrowserPageWindowState`（5）、`BrowserPageZoomOptions`（1）、`BrowserPageZoomResult`（1）、`BrowserPendingEventsResult`（1）、`BrowserPerformanceInsightOptions`（1）、`BrowserPerformanceInsightResult`（1）、`BrowserPerformanceTraceStartOptions`（1）、`BrowserPerformanceTraceStartResult`（1）、`BrowserPerformanceTraceStopResult`（1）、`BrowserPressKeyOptions`（1）、`BrowserPressKeyResult`（1）、`BrowserRecipeDryRunSummary`（3）、`BrowserRecipeSkeleton`（1）、`BrowserRecipeSkeletonPreview`（3）、`BrowserRecipeSkeletonStep`（1）、`BrowserRecipeSkeletonStepKind`（1）、`BrowserSaveRecipeStepRequest`（3）、`BrowserSaveRecipeStepResult`（3）、`BrowserScreencastStartOptions`（1）、`BrowserScreencastStartResult`（1）、`BrowserScreencastStopOptions`（1）、`BrowserScreencastStopResult`（1）、`BrowserScreenshotArtifact`（4）、`BrowserSearchEngineId`（1）、`BrowserSiteContext`（6）、`BrowserSwitchPageTargetOptions`（1）、`BrowserSwitchPageTargetResult`（1）、`BrowserTargetActionOptions`（1）、`BrowserTargetActionResult`（1）、`BrowserTurnContextSnapshot`（2）、`BrowserTypeTextOptions`（1）、`BrowserTypeTextResult`（1）、`BrowserUploadFileOptions`（1）、`BrowserUploadFileResult`（1）、`BrowserUserScriptLastRun`（2）、`BrowserUserScriptManageRequest`（4）、`BrowserUserScriptMutationResult`（5）、`BrowserUserScriptRecord`（2）、`BrowserViewportOptions`（1）、`BrowserViewportResult`（4）、`BrowserWaitForSelectorOptions`（1）、`BrowserWaitForSelectorResult`（1）、`BrowserWorkspaceArtifactKind`（2）、`BrowserWorkspaceArtifactListItem`（1）、`BrowserWorkspaceArtifactsOverview`（3）、`ProjectReadFileResult`（1）
- `./core/contracts`（33 个）：`BrowserAutomationMode`（5）、`BrowserCaptureScreenshotOptions`（2）、`BrowserElementSelection`（15）、`BrowserElementSelectionStep`（2）、`BrowserNavigationHistoryEntry`（2）、`BrowserNavigationHistoryRestore`（6）、`BrowserPageNavigationAction`（3）、`BrowserPageNavigationOptions`（2）、`BrowserPageNavigationResult`（2）、`BrowserPagePreviewFrame`（1）、`BrowserPagePreviewPointerEvent`（1）、`BrowserPagePreviewStreamEvent`（2）、`BrowserPageWindowState`（4）、`BrowserPageZoomOptions`（4）、`BrowserRecipeDryRunSummary`（4）、`BrowserRecipeSkeletonPreview`（3）、`BrowserRecipeSkeletonStepKind`（1）、`BrowserSaveRecipeStepRequest`（2）、`BrowserSaveRecipeStepResult`（2）、`BrowserScreenshotArtifact`（7）、`BrowserSearchEngineId`（3）、`BrowserSiteContext`（9）、`BrowserUserScriptManageRequest`（3）、`BrowserUserScriptMutationResult`（3）、`BrowserUserScriptOverview`（1）、`BrowserUserScriptRecord`（1）、`BrowserUserScriptRunAt`（1）、`BrowserUserScriptWorld`（1）、`BrowserViewportOptions`（13）、`BrowserViewportResult`（2）、`BrowserWorkspaceArtifactKind`（4）、`BrowserWorkspaceArtifactListItem`（2）、`BrowserWorkspaceArtifactsOverview`（3）
- `./tools`（5 个）：`BrowserLoginGatePort`（1）、`BrowserPageState`（1）、`BrowserToolContext`（1）、`ToolBrowserApi`（2）、`VelaTool`（1）
- `./composition`（4 个）：`BrowserCompositionAdapter`（2）、`ControlledBrowserSurface`（3）、`ControlledBrowserSurfaceInput`（2）、`ControlledBrowserSurfaceRenderOptions`（1）
- `./composition/mod`（1 个）：`BrowserToolCategoryId`（1）
- `./runtime`（3 个）：`BrowserPermissionRequestHandler`（1）、`BrowserWebAuthnAccountSelectionRequest`（2）、`ElectronBrowserRuntimeOptions`（2）
