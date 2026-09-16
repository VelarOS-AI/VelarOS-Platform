# `@velaros-ai/browser` 0.2.20 → 0.3.0 迁移表

这是一次**破坏性**发布：6 个入口收成 **4 个**，公开面 466 个名字收到 318 个（**177 个下线、29 个新名字**）。
类一个都不出包，工具函数一个都不出包。**模型面一个字节没变**——32 份工具 schema 与
`baselines/capabilities/browser-input-schemas.json` 逐字节一致（`check:capabilities-schemas` 现场核过）。

- 判断口径：消费点 = 直接 `import … from '@velaros-ai/browser*'` 的源文件数（注释与文档不计）。
- 仓内消费点**本轮已全部改完**（包内 19 个测试与三个门禁脚本）。
- 产品仓的调用点**本轮不改**，只列进第 6 节。Termel、Extension 零引用。

改造方案见 `browser.md`（§2.6 四个入口、§3.1 产品面、§3.4 要删的导出与替代）；
裁决见 `foundation-pending-decisions.md` 第二节 B5 / B9 / B10；仓库标准见
`docs/architecture/module-ownership.md`。

---

## 1. 入口前后对照

| 旧入口（6） | 新入口（4） | 说明 |
| --- | --- | --- |
| `./core` | `.`（值与合同接口）/ `./contracts`（可移植数据） | 408 个符号整片出包的那个入口没了；零件不再单独交出去 |
| `./core/contracts` | `./contracts` | 内容收窄：只剩 `types/browser.ts` 的可移植数据 + `contract/constants.ts` 的常量表；地址栏、偏好、截图选项三件**值**搬去 `./renderer` |
| `./tools` | `.` | 工具集合与登录墙 |
| `./composition` | `./renderer` | React 合成边界；React 是可选 peer，只在这一个入口出现 |
| `./composition/mod` | `.` | mod 定义；入口名不许带 `/`（门禁硬约束） |
| `./runtime` | `./electron` | 这条链值 import `electron`（可选 peer），放进根入口会让不装 Electron 的 Node 宿主一加载就失败 |

新入口的值一共 **38 个**：

| 入口 | 值 |
| --- | --- |
| `.` | `browserTools`、`createBrowserBundledModDefinition`；站点工作区四件工厂 `createBrowserWorkspaceFileAccess`、`createBrowserSiteWorkspaceFileAccess`、`createBrowserWorkspaceArtifacts`、`createBrowserUserScriptStore`、`createBrowserLoginGate`；两个实例 `browserActionPolicy`、`browserRecipes`；加 `contract/constants.ts` 的常量表 |
| `./contracts` | 同一批常量表（`.` 的可移植子集），没有别的值 |
| `./renderer` | `browserAddress`、`browserPreferences`、`browserScreenshotPolicy`、`browserComposition` |
| `./electron` | `createElectronBrowserRuntime`、`createBrowserKernelModule`、`BrowserRuntimeCapability` |

`browserSafeEntries` 是 `contracts.ts` 与 `renderer.ts`：这两条的引用链不碰 Node 内置模块，渲染进程可以直接加载。

---

## 2. 新增的名字（29）

| 新名 | 它顶替了谁 |
| --- | --- |
| `browserAddress`（`BrowserAddressApi`） | `getBrowserSiteHost`、`getBrowserUrlCandidate`、`isLocalBrowserUrl`、`resolveBrowserNavigationInput`、`resolveBrowserSearchOrNavigationInput`、`resolveBrowserSearchFallbackUrl`、`buildBrowserSearchUrl`、`isBrowserNavigationLikeInput` 八个函数 |
| `browserPreferences`（`BrowserPreferencesApi`） | `resolveBrowserSearchEngineId`、`resolveBrowserAutomationMode`、`isBrowserSearchEngineId`、`isBrowserAutomationMode`（守卫并进解析） |
| `browserScreenshotPolicy`（`BrowserScreenshotPolicyApi`） | `buildBrowserScreenshotOptions` |
| `browserActionPolicy`（`BrowserActionPolicyApi`） | `checkBrowserActionPolicy` |
| `browserRecipes`（`BrowserRecipesApi`） | `normalizeBrowserRecipePath`、`buildRecipeSkeletonPreview`、`assertSameBrowserOrigin`、`runBrowserRecipeDryRun`（同源核对并进 `preview`） |
| `browserComposition`（`BrowserCompositionApi`） | `BrowserCompositionProvider`、`useControlledBrowserSurface` |
| `createBrowserLoginGate(port)`（`BrowserLoginGateApi`） | `withBrowserLoginGate(api, port, { ledger })` + `BrowserLoginGateLedger`；账本就是门控实例本身 |
| `createBrowserUserScriptStore(access)`（`BrowserUserScriptManagerApi`） | `new BrowserUserScriptManager(access)`；`matchesUrl` 顶替 `browserUserScriptMatchesUrl` |
| `createBrowserWorkspaceArtifacts(access)`（`BrowserWorkspaceArtifactManagerApi`） | `createBrowserWorkspaceArtifactAccess(args)` 改名，返回接口而不是类 |
| `createElectronBrowserRuntime(options, setup?)`（`ElectronBrowserRuntimeApi`） | `new ElectronBrowserRuntime(options, hub)` |
| `BrowserToolCollection` | `browserTools` 的公开类型（原来没有显式标注） |
| `BrowserBundledModOptions` | `createBrowserBundledModDefinition()` 新的入参：`guestSpaceIds`（裁决 B5） |
| `BrowserLoginGateOriginState`、`WriteBrowserArtifactInput`、`SaveBrowserPageSnapshotInput`、`SaveBrowserRecipeSkeletonInput`、`VelaToolSurface`、`BrowserWorkspaceFileAccessApi` 等 | 原先没出包、但公开签名用得到的形状 |
| `BrowserEvaluateLimits` | 页面求值通道的对外上限（原来是散在 `utils/page-scripts/evaluate.ts` 的裸常量） |

`contract/constants.ts` 同时收了原先散在实现里的六组常量：`BrowserSearchEngineIds`、`BrowserAutomationModes`、
`DefaultBrowserSearchEngine`、`DefaultBrowserAutomationMode`、`BrowserViewNotAttachedReason`、
`BrowserFallbackVirtualPointer`、`BrowserResidentToolNames`（从 `Set` 改成冻结数组）。

---

## 3. 有替代的旧名（32）

### 3.1 纯策略函数 → 实例的方法面

| 旧名（入口） | 新名 / 去向 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `getBrowserSiteHost` | `browserAddress.siteHost` | `./renderer`（`.` 也有） | 2（已改完） | Desktop 4（主进程 3、渲染 1） |
| `getBrowserUrlCandidate` | `browserAddress.urlCandidate` | 同上 | 1（已改完） | Desktop 2 |
| `isLocalBrowserUrl` | `browserAddress.isLocalUrl` | 同上 | 1（已改完） | Desktop 2 |
| `resolveBrowserNavigationInput` | `browserAddress.resolveNavigationInput` | 同上 | 2（已改完） | Desktop 2、Workbench 1 |
| `resolveBrowserSearchOrNavigationInput` | `browserAddress.resolveSearchOrNavigationInput(value, searchEngine?)`（第二参从 `{ searchEngine }` 摊平） | 同上 | 2（已改完） | Desktop 2、Workbench 1 |
| `resolveBrowserSearchFallbackUrl` | `browserAddress.searchFallbackUrl` | 同上 | 1（已改完） | Desktop 1 |
| `buildBrowserSearchUrl`、`isBrowserNavigationLikeInput` | `browserAddress.searchUrl`；后者并进 `resolveNavigationInput`（返回 undefined 即「不像网址」） | 同上 | 0 | 0 |
| `resolveBrowserSearchEngineId` / `resolveBrowserAutomationMode` | `browserPreferences.resolveSearchEngineId` / `.resolveAutomationMode` | `./renderer`（`.` 也有） | 0 | Desktop 1（主进程配置） |
| `isBrowserSearchEngineId` / `isBrowserAutomationMode` | 已删无替代：守卫并进解析，认不出就回出厂缺省 | — | 0 | 0 |
| `buildBrowserScreenshotOptions` | `browserScreenshotPolicy.buildOptions` | `./renderer`（`.` 也有） | 1（已改完） | Desktop 1（渲染） |
| `checkBrowserActionPolicy` | `browserActionPolicy.check` | `.` | 1（已改完） | Desktop 1（`src/mods/browser/main/context/BrowserTools.ts`） |
| `normalizeBrowserRecipePath` | `browserRecipes.normalizePath` | `.` | 1（已改完） | Desktop 1 |
| `buildRecipeSkeletonPreview` + `assertSameBrowserOrigin` | `browserRecipes.preview(path, content, siteUrl?)`（同源核对并进去） | `.` | 1（已改完） | Desktop 1 |
| `runBrowserRecipeDryRun` | `browserRecipes.dryRun` | `.` | 0 | Desktop 1 |
| `isBrowserViewNotAttachedError` / `BrowserViewNotAttachedReason` | 常量 `BrowserViewNotAttachedReason` 留在 `./contracts`；判定改 `AppError.from(error).context?.reason === BrowserViewNotAttachedReason` | `./contracts` | 1（已改完） | Desktop 1 |
| `getRelativePathInsideRoot` / `toPortableRelativePath` | 已删无替代：宿主用 `@velaros-ai/platform` 的 `relativePathTextInside` / `toPortablePathText` | — | 0 | Desktop 1 |

### 3.2 类 → 工厂与接口

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `new ElectronBrowserRuntime(o, hub)` | `createElectronBrowserRuntime(o, hub)`；类型位用 `ElectronBrowserRuntimeApi` | `./electron` / `.` | 1（已改完） | Desktop 4、Workbench 6（各 1 处构造，其余当类型用） |
| `BrowserUserScriptManager`（类） | `createBrowserUserScriptStore(access)`；类型位 `BrowserUserScriptManagerApi` | `.` | 0 | Desktop 1、Workbench 1 |
| `BrowserWorkspaceArtifactManager`（类）、`createBrowserWorkspaceArtifactAccess` | `createBrowserWorkspaceArtifacts(access)`；类型位 `BrowserWorkspaceArtifactManagerApi` | `.` | 0 | Desktop 2 |
| `BrowserWorkspaceFileAccess`（类） | `createBrowserWorkspaceFileAccess` / `createBrowserSiteWorkspaceFileAccess`（名字不变，返回 `BrowserWorkspaceFileAccessApi`） | `.` | 1（已改完） | Desktop 4、Workbench 1 |
| `BrowserLoginGateLedger`（类）、`withBrowserLoginGate`、`BrowserLoginGateOptions` | `createBrowserLoginGate(port).wrap(api)`；账本是门控实例本身，一个会话一份 | `.` | 1（已改完） | Desktop 1 |
| `browserUserScriptMatchesUrl` / `browserUserScriptPatternMatches` | `store.matchesUrl(script, url)`；通配判定不出包 | `.` | 1（已改完） | 0 |
| `BrowserCompositionProvider` / `useControlledBrowserSurface` | `browserComposition.Provider` / `.useControlledSurface` | `./renderer` | 0 | Desktop 1、Workbench 2 |
| `BrowserSessionManager`、`BrowserPageWaiter`、`BrowserDiagnosticsRecorder`（连同 `BrowserSessionManagerOptions`） | 已删无替代：运行时内部装好的零件；Desktop 那两个直接 `new` 它们的测试要挪进本包 `test/` | — | 1（已改完） | Desktop 2（`tests/maintained/src/main/browser/`） |
| `createElectronWebContentsBrowserPageDriver` | 已删无替代：运行时缺省就用它；要换驱动走 `options.createPageDriver` | — | 1（已改完） | 0 |
| `createBrowserBundledModDefinition()` | 签名多一个可选入参 `{ guestSpaceIds }`：**不传就只挂浏览器空间**（裁决 B5，原先包里写死 `['project']`） | `.` | 1（已改完） | Desktop 1、Workbench 3 |
| `BrowserResidentToolNames` | 从 `Set<string>` 改成**冻结数组**，判定用 `.includes`；进 `./contracts` | `./contracts` | 1（已改完） | Workbench 1 |
| `BrowserToolCategoryDefinitions`、`BrowserToolCategoryIds`、`BrowserToolNamesByCategory`、`BrowserToolCategoryId` | 已删无替代（零消费）：分类看 `createBrowserBundledModDefinition().manifest.contributes` | — | 1（已改完） | 0 |
| `ToolBrowserApi`、`ToolContext`、`BrowserToolContext`、`VelaTool`、`BrowserPageState`、`BrowserLoginGatePort` | 名字不变，改从 `.` 取 | `.` | 0 | Desktop 3、Workbench 1 |

---

## 4. 已删、没有替代的名字（145）

这些名字在 0.3.0 里**不再出包**。它们要么是包内实现细节，要么是没有任何公开签名用得到的数据。
需要它们的功能，走 §3 里的替代面。

### 4.1 内部类与它们的选项（26）

`CdpBrowserPageDriver`、`CdpWebSocketTransport`、`CdpExternalBrowserLauncher`、`CdpScreencastRecorder`、
`CdpTraceCollector`、`BrowserCdpNetworkController`、`BrowserPlatformCompatibility`、`CdpInteractionEngine`、
`CdpPageDataEngine`、`CdpScreenshotEngine`、`BrowserPerformanceOrchestrator`、`BrowserPerformanceTraceEngine`、
`BrowserSessionActionQueue`、`BrowserPendingEventsBroker`、`BrowserTargetRefStore`、`BrowserActivityCoordinator`、
`ElectronWebContentsBrowserPageDriver`，加它们的 `*Options` / `*Deps`（`CdpBrowserPageDriverOptions`、
`CdpBrowserPageDriverConnectOptions`、`CdpWebSocketTransportOptions`、`CdpWebSocketTransportConnectOptions`、
`CdpExternalBrowserLauncherDependencies`、`BrowserCdpNetworkControllerDeps`、`BrowserActivityCoordinatorOptions`、
`BrowserSessionManagerOptions`、`BrowserLoginGateOptions`）。

它们都是 `createElectronBrowserRuntime` 在内部装好的零件，装配者不需要认识它们。

### 4.2 页面脚本构建器与工具函数（约 60）

页面脚本：`buildEvaluateScript`、`buildInspectionScript`、`buildElementQueryScript`、`buildTargetActionScript`、
`buildDragTargetScript`、`buildScrollScript`、`buildPageWaitScript`、`buildWaitForSelectorScript`、
`buildPageStorageScript`、`buildListMediaSourcesScript`、`buildPageResourcesScript`、`buildTableExtractionScript`、
`buildListExtractionScript`、`buildPageContentExtractionScript`、`buildResolveFileInputScript`、
`buildHighlightScript`、`buildHighlightFromTargetScript`、`buildActionEffectSnapshotScript`、
`buildBrowserLoginDetectionScript`、`browserLoginDetectionScriptFragment`、
`buildBrowserInlineInferenceToolkitSnippet`、`precheckBrowserInlineScriptSyntax`、
`simplifyBrowserEvaluatedValue`、`describeBrowserEvaluatedElement`。

数值与路径：`clampInteger`、`clampNumber`、`clampZoomFactor`、`readBoundedString`、`readFiniteNumber`、
`resolveBrowserWorkspacePath`、`resolveWorkspaceFilePath`、`normalizeBrowserArtifactJsonPath`、
`resolveExternalPageUrl`、`normalizeBrowserPressKeyOptions`、`buildBrowserViewportDeviceMetrics`、
`DEFAULT_BROWSER_VIEWPORT`。

诊断、CDP 与产物：`takeBrowserDiagnosticWindow`、`clearBrowserDiagnosticEntries`、
`buildBrowserNetworkCaptureNotice`、`applyCdpEmulation`、`syncCdpNetworkConditions`、
`createDefaultCdpEmulationState`、`CdpNetworkThrottlingPresets`、`captureCdpHeapSnapshot`、
`createWebContentsCdpTraceTransport`、`encodeScreencastFramesToGif`、`DefaultScreencastStartOptions`、
`serializeBrowserTraceToGzip`、`extractKeyMetricsFromSummary`、`buildBrowserArtifactRelativePath`、
`buildBrowserPageSnapshotName`、`buildBrowserRecipeSkeletonName`、`buildBrowserRecipeSkeleton`、
`applyBrowserRecipeTemplate`、`buildBrowserFallbackVirtualPointerSvg`、`buildBrowserLoginGateMessage`、
`buildBrowserLoginGateRecord`、`buildBrowserLoginGateRiskScope`、`resolveBrowserLoginGateOrigin`。

仓库标准的原话：utils 的函数不出包。

### 4.3 可调参数与规则数据（6）

`BrowserScreenshotDefaultNetworkIdleMs`、`BrowserScreenshotDefaultDomStable`、
`BrowserScreenshotDefaultModelImage`、`BrowserEvaluateSimplifyMaxDepth`、`BrowserEvaluateSimplifyMaxEntries`、
`BrowserEvaluateMaxResultChars`（最后一个的对外含义进了 `BrowserEvaluateLimits.resultChars`）。

### 4.4 没有公开签名用得到的数据类型（约 53）

CDP 与驱动：`CdpBrowserPageDriverTransport`、`CdpWebSocketLike`、`CdpSend`、`CdpTraceTransport`、
`ScreencastFrameDecoder`、`EncodeScreencastGifOptions`、`CdpWorkspaceFileAccess`。

运行时：`BrowserPageDriverKernel`、`BrowserPageDriverSession`、`BrowserRuntimeKernel`、
`BrowserRuntimePageDriverSession`、`BrowserSession`、`BrowserParsedTraceRecording`、`BrowserTraceParseMetadata`、
`BrowserPointerPoint`、`BrowserTargetActionClickMode`、`BrowserTargetActionInternalEffectSnapshot`、
`BrowserDiagnosticsLimits`、`BrowserViewportDeviceMetrics`、`BrowserCommandSpec`。

会话与工具：`BrowserSessionActionOptions`、`BrowserUserActivityWaitResult`、`BrowserUserActivityItem`、
`BrowserUserActivitySummary`、`BrowserTargetActionScriptBuildOptions`、`BrowserWorkspacePath`、
`BrowserPageContentFormat`、`BrowserExtractPageContentOptions`、`BrowserExtractPageContentResult`、
`BrowserObserveActionsResult` 与 `BrowserObserved*` 十个候选 / 回放形状。

**四个宿主界面自己在用、但本包已经没有任何实现产出的形状**：`BrowserWorkspaceArtifactListItem`、
`BrowserWorkspaceArtifactsOverview`、`BrowserSaveRecipeStepRequest`、`BrowserSaveRecipeStepResult`。
它们从来不是本包产出的数据，是 Desktop 的产物面板与 recipe 面板自己拼的 IPC 形状——
**形状一个字段没变**，Desktop 把这四个 interface 抄进自己的 IPC 契约即可。

---

## 5. 门禁改了一条标准：懒加载登记（裁决 B9）

`check:module-ownership` 原先一刀切禁止动态 `import()`。浏览器的 vendor DevTools 性能引擎是 2.5 MB，
静态 import 会让每个加载本包的进程都付这笔钱，而它只在 `browser:performance` 真跑 trace 时才用得到。

新做法：登记表加字段 `lazyImports`，每项写明 `{ specifier, file, reason }`——加载什么、**唯一**允许在哪个文件里加载、
为什么必须懒加载。没登记的动态 import 照旧拦下；登记了却没人加载的，也当场报「不用的删掉」。
全仓目前只有一条登记：browser 的性能引擎。

---

## 6. 产品仓要改的调用点

### 6.1 VelarOS-Desktop（82 个文件）

绝大多数是**只换入口名、名字不变**的机械替换（渲染进程 43 个文件 + `packages/ipc` 6 个从
`@velaros-ai/browser/core/contracts` 改成 `@velaros-ai/browser/contracts`）。真要动代码的只有这几类：

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `src/mods/browser/main/context/BrowserTools.ts`（799 行适配层） | `/core`: `checkBrowserActionPolicy`、`createBrowserSiteWorkspaceFileAccess`、`BrowserWorkspaceArtifactManager`、`BrowserUserScriptManager`、`BrowserLoginGateLedger`；`/tools`: `withBrowserLoginGate` | `browserActionPolicy.check`；三个工厂 `createBrowserWorkspaceArtifacts` / `createBrowserUserScriptStore` / `createBrowserLoginGate`；`createBrowserLoginGate(port).wrap(api)` |
| `src/mods/browser/main/**` 里 new 过内部类的地方 | `/core` 的类 | 一律改成 §3.2 的工厂 |
| recipe 面板那条 IPC | `/core`: `normalizeBrowserRecipePath`、`buildRecipeSkeletonPreview`、`assertSameBrowserOrigin`；`/tools`: `runBrowserRecipeDryRun` | `browserRecipes.normalizePath` / `.preview` / `.dryRun` |
| 渲染进程地址栏与截图设置（3 个文件） | `/core/contracts` 的五个地址函数、`buildBrowserScreenshotOptions`、`BrowserFallbackVirtualPointer` | `@velaros-ai/browser/renderer` 的 `browserAddress` / `browserScreenshotPolicy`；常量仍在 `./contracts` |
| 主进程配置 | `/core/contracts`: `resolveBrowserAutomationMode`、`resolveBrowserSearchEngineId` | `browserPreferences.*`（从 `.` 或 `./renderer` 取） |
| 组合根与 IPC（4 个文件） | `/runtime`: `ElectronBrowserRuntime`、`createBrowserKernelModule`、`BrowserRuntimeCapability` | `createElectronBrowserRuntime` from `@velaros-ai/browser/electron`；类型位 `ElectronBrowserRuntimeApi`（从 `.` 取） |
| 空间配方（装 mod 那一处） | `createBrowserBundledModDefinition()` | `createBrowserBundledModDefinition({ guestSpaceIds: ['project'] })`——**不传就不再挂到项目空间** |
| `tests/maintained/src/main/browser/` 两个测试（216 行） | `/runtime`: `BrowserSessionManager`、`BrowserPageWaiter`、`BrowserDiagnosticsRecorder` | 这三个不再出包；按标准把这两个测试挪进 `packages/browser/test/` |
| `UnattendedTaskToolPolicy.ts`、两份技能文档、`docs/modules/infrastructure-browser.md` | 点名了 40→32 那一轮删掉的工具名 | 随升级改名或删名（`foundation-pending-decisions.md` X4） |

另外要改但不是 import 的：`package.json` 与 `bun.lock` 的版本（`^0.3.0`）、
`tsconfig.node.json` / `tsconfig.web.json` 里 `@velaros-ai/browser/*` 的 paths（收成四条）、
`packages/arch-guard-velaros` 里按 `browser/dist/composition/`、`browser/dist/tools/` 钉路径的两条检查
（dist 布局已经变了，`foundation-pending-decisions.md` X2）。

### 6.2 VelarOS-Workbench（13 个文件）

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `src/main/**`（6 个） | `/runtime`: `ElectronBrowserRuntime` 等 | `@velaros-ai/browser/electron` 的 `createElectronBrowserRuntime`；类型位 `ElectronBrowserRuntimeApi` |
| `WorkbenchBrowserToolHost.ts` | `/composition/mod`: `createBrowserBundledModDefinition`、`BrowserResidentToolNames`、`BrowserModId` | 前两个从 `.`（常驻集也在 `./contracts`），`BrowserModId` 从 `./contracts`；常驻集从 `Set` 改成数组，`.has(x)` → `.includes(x)`；初始可见工具名单里的 `browser:site_context` 已在 40→32 那一轮并进 `get_page_state` |
| 渲染进程（5 个） | `/composition`: `BrowserCompositionProvider`、`useControlledBrowserSurface` | `@velaros-ai/browser/renderer` 的 `browserComposition.Provider` / `.useControlledSurface` |
| `/core/contracts` 的地址函数（渲染 1） | 同 Desktop | `browserAddress.*` from `@velaros-ai/browser/renderer` |

### 6.3 VelarOS-Termel / Extension

零引用，不受影响。

---

## 7. 本轮**没有**做完的（已知偏离裁决）

- **B6 `bindToolApi`**：`ElectronBrowserRuntime` 还是 56 个公开成员，两个宿主仍各写一份 800–1,200 行的适配层
  把它们转接成 `ToolBrowserApi`。把这 50 个方法在包内绑一遍等于把宿主那份适配层搬进来，
  正确性只能在产品仓里验证（本仓没有 Electron 会话可跑），所以留给「产品同车」那一轮，
  与 Desktop / Workbench 的适配层删除一起做。
- **B7 用户脚本高风险操作走审批端口**：`BrowserToolContext` 还没有 `approval` 字段，启用脚本、切 main world、
  扩大 match 这三件仍然只靠提示词与「改代码即停用」挡着。加一个没有宿主实现的端口等于加一个恒空的门，
  同样要与产品侧同车。
- 模型面本轮**一个字节没改**：工具面 40→32 与提示词重写是上一轮做的，本轮只动结构与入口。
