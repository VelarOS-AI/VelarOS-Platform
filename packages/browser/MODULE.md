# @velaros-ai/browser 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 门禁：`bun run check:module-ownership`（本模块零条）。
>
> 0.3.0 是一次**破坏性**发布：六个入口收成四个，类与工具函数不再出包。
> 逐符号去向见 `docs/engineering/refactor-plans/browser-migration.md`。

## 这是什么

**浏览器能力包**：32 个模型面工具（进站、看页面、动作、提取、截图、网络与诊断、产物、配方、用户脚本、性能、录屏），
它们背后的执行层，站点工作区（产物、用户脚本、登录墙），CDP 协议层与领域引擎，
以及 Electron 主进程那一份浏览器运行时。

「浏览器空间」的身份是**站点源**：一个站点一个工作区，写只写当前根、读可回退到历史根。
本包不认识别的空间——工具要不要挂到项目空间之类的地方，由**宿主**在装 mod 时传 `guestSpaceIds`。

## 提供什么

四个入口，对应 `package.json` 的 `exports`：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主（两个产品的主进程与测试） | 工具集合与内置 mod、站点工作区四件工厂、recipe 与动作策略两个实例，加四个入口里全部公开接口的**类型** |
| `./contracts` | 任何进程，含渲染进程与 IPC 契约 | **浏览器安全的纯类型**浏览器 DTO 加常量表（引用链不碰 Node 内置模块） |
| `./renderer` | 渲染进程 | 地址栏、偏好、截图选项三件纯策略与 React 合成边界——渲染进程真要调的**值**；根入口会带进 `node:fs`，可移植入口按标准只许常量与类型 |
| `./electron` | Electron 主进程 | 浏览器运行时与内核模块；这条链值 import `electron`（可选 peer），放进根入口会让不装 Electron 的 Node 宿主一加载就失败 |

### 导出的值

| 分组 | 名字 |
| --- | --- |
| 工具与 mod（`.`） | `browserTools`、`createBrowserBundledModDefinition` |
| 站点工作区（`.`） | `createBrowserWorkspaceFileAccess`、`createBrowserSiteWorkspaceFileAccess`、`createBrowserWorkspaceArtifacts`、`createBrowserUserScriptStore`、`createBrowserLoginGate` |
| 策略与 recipe（`.`） | `browserActionPolicy`、`browserRecipes` |
| 渲染进程（`./renderer`） | `browserAddress`、`browserPreferences`、`browserScreenshotPolicy`、`browserComposition` |
| Electron（`./electron`） | `createElectronBrowserRuntime`、`createBrowserKernelModule`、`BrowserRuntimeCapability` |
| 常量表（`.` 与 `./contracts`） | `BrowserModId`、`BrowserSpaceId`、`BrowserResidentToolNames`、`BrowserWorkspaceArtifactDirectoryMap`、`BrowserWorkspaceArtifactFormatExtensionMap`、`BrowserSearchEngineIds`、`BrowserAutomationModes`、`DefaultBrowserSearchEngine`、`DefaultBrowserAutomationMode`、`BrowserFallbackVirtualPointer`、`BrowserViewNotAttachedReason`、`BrowserErrorCodes`、以及九张上限表（`BrowserFileLimits`、`BrowserUserScriptLimits`、`BrowserFetchLimits`、`BrowserExtractDefaults`、`BrowserInspectLimits`、`BrowserCaptureLimits`、`BrowserPerformanceLimits`、`BrowserPendingEventLimits`、`BrowserPageDataLimits`、`BrowserEvaluateLimits`） |

类一个都不出包：CDP 驱动、引擎、会话队列、运行时都是上面的工厂装好的零件；
工具函数（页面脚本构建、路径判定、诊断过滤、recipe 解析）同理。

### 产品面接口（`contract/provides.ts` 登记，定义在各自的类上方）

`BrowserToolCollection`、`VelaTool`、`VelaToolSurface`、
`BrowserWorkspaceFileAccessApi`、`BrowserWorkspaceArtifactManagerApi`、`BrowserUserScriptManagerApi`、
`BrowserLoginGateApi`、`BrowserRecipesApi`、`BrowserActionPolicyApi`、
`BrowserAddressApi`、`BrowserPreferencesApi`、`BrowserScreenshotPolicyApi`、`BrowserCompositionApi`、
`ElectronBrowserRuntimeApi`，以及 mod 装配用的 `BrowserBundledModDefinition` 与 `BrowserBundledModOptions`。

### 注入面接口（`contract/requires.ts`）

工具上下文 `BrowserToolContext`（别名 `ToolContext`）里的宿主端口 `ToolBrowserApi` 是工具调宿主的唯一口子；
扩展点有 `BrowserPageDriver`（连别的浏览器后端）、`BrowserPageDriverDownloadItem`、`BrowserSystemPointerDriver`、
`BrowserExternalPageLauncher`；登录墙走 `BrowserLoginGatePort`（拿不到审批通道必须回 `approved: false`）；
登录墙的裁决形状是 `BrowserLoginGateDecision`；
React 合成走 `BrowserCompositionAdapter` / `ControlledBrowserSurface` / `ControlledBrowserSurfaceRenderOptions`；
挂进内核走 `CreateBrowserKernelModuleOptions` 与 `BrowserRuntimeCapabilityService`。

## 骨干链路

32 个工具的定义、分组、常驻集与随包 mod 清单都在工具文件 `impl/BrowserTools.ts`，execute 一行交给 `impl/operations/` 的执行类。

- **一次工具调用**：`browserTools[name].execute(input, ctx)` → `ctx.browser`（宿主拼的 `ToolBrowserApi`）→
  Electron 运行时 → 会话动作队列按会话串行 → 交互 / 页面数据 / 截图 / 性能引擎 → 页面驱动
  （外部页面走 CDP 驱动，内嵌页面临时包一个 WebContents 驱动）→ 页面脚本 → 结果。
- **进站与产物**：`browser:enter_site` 绑定站点工作区并刷新清单；`browser:files`、`browser:extract`、
  `browser:capture_screenshot` 的产物经 `createBrowserWorkspaceArtifacts` 落进各自的目录。
- **挂起事件**：会话管理接住弹窗 / 下载 / 权限 → 挂起事件 broker 登记、超时按缺省结算 →
  `handle_*` 与 `list_pending_events` 只在回合快照里有对应事件时出现。
- **登录墙**：inspect 与截图的页面脚本内嵌检测片段 → `createBrowserLoginGate(port).wrap(api)` 命中后经宿主征询 →
  批准后重读一次；每个站点每会话最多问一次。
- **recipe**：`browser:recipe` 生成骨架 → 读 → 跑 → 重跑；宿主界面的「干跑」按钮经 `browserRecipes.dryRun` 走同一个执行器。

逐个工具落在哪条链路上：

| 链路 | 工具 |
| --- | --- |
| 会话与站点 | `browser:enter_site`、`browser:leave_site`、`browser:show_page`、`browser:list_page_targets`、`browser:switch_page_target` |
| 看页面 | `browser:get_page_state`、`browser:inspect_page`、`browser:observe_actions`、`browser:query_elements`、`browser:read_page_data`、`browser:read_page_storage`、`browser:capture_screenshot` |
| 动作 | `browser:act`、`browser:evaluate_script` |
| 取内容与产物 | `browser:extract`、`browser:files`、`browser:upload_file`、`browser:fetch_resource`、`browser:list_media_sources`、`browser:list_page_resources` |
| 挂起事件 | `browser:list_pending_events`、`browser:wait_for_pending_event`、`browser:handle_dialog`、`browser:handle_download`、`browser:handle_permission` |
| 诊断与网络 | `browser:get_page_diagnostics`、`browser:get_network_request`、`browser:get_network_response_body` |
| 性能与录制 | `browser:performance`、`browser:screencast` |
| 配方与用户脚本 | `browser:recipe`、`browser:user_scripts` |

## 依赖什么

`@velaros-ai/core`（判定、日志、`AppError`、计时域）、`@velaros-ai/tool-contract`（工具定义与渲染）、
`@velaros-ai/kernel`（能力令牌与内核模块）、`@velaros-ai/platform`（路径包含判定、进程树终止）、
`zod`、`gifenc`，以及 `vendor/devtools-performance-engine`（唯一一个登记过的懒加载目标）。
可选 peer：`electron`（只有 `./electron` 那条链）、`react`（只有 `./renderer` 的合成边界）、`@velaros-ai/agent`（工具契约）。

## 状态归谁

- **持久状态**属于站点工作区：产物、用户脚本索引与清单都在宿主给的 `workspaceRoot` 下。
- **进程内状态**只在实例上：会话动作队列、挂起事件、ref 分代、用户活动、登录墙账本、CDP 调试器占用，
  全是运行时或门控实例的字段；模块级没有可变状态。
- 本包不读 `VELAROS_*` 环境变量；只读 `LOCALAPPDATA` / `PROGRAMFILES` 找本机 Chrome（属操作系统惯例）。

## 生命周期

`createElectronBrowserRuntime(options, setup?)` → 宿主注册权限与 WebAuthn 处理、订阅回调 →
按站点开会话 → `createBrowserKernelModule({ runtime })` 挂进内核（可选）→ 退出时 `runtime.dispose()`。
外部浏览器由 `BrowserExternalPageLauncher` 拉起，会话关掉时一并收。

## 失败语义

- 模型看得到的失败一律是 `AppError`：入参不合法 `VALIDATION`，页面没接上带
  `context.reason === BrowserViewNotAttachedReason`，CDP 超时 `TIMEOUT`，网络类 `NETWORK`。
- 视图没接上这一条只陈述事实并打标记，**补救办法归宿主**：文案可以改，标记不能——它是接缝。
- 点击没命中不假装成功：坐标恢复会先截一张标注图，恢复不了就如实回 `matched: false` 与原因。
- 站点工作区越界、跨站点读产物、用户脚本改代码后未确认就启用，一律当场拒绝而不是降级执行。

## 不变量

共 16 条，登记在 `spec/invariants.md`（测试 12、门禁 3、未验证 1 条）。
验收测试 `spec/acceptance.test.ts` 只经 `.` 与 `./renderer` 两个入口，每条测试档不变量各有一个以编号开头的用例。

## 非目标

- **不认识别的空间**：工具挂到哪些空间由宿主传 `guestSpaceIds`，本包不点名「项目空间」。
- **不做宿主界面**：预览窗口、产物面板、recipe 面板都是产品的事；本包只交出判定与数据。
- **不持有登录态**：登录态由浏览器 partition 持久化，门控只负责「这一轮要不要停下来等人」。
- **不替宿主决定审批**：拿不到审批通道时登录墙一律按「未批准」走，不静默放行。
- **不在包里读环境变量选后端**：自动化模式与搜索引擎是宿主配置，本包只提供闭集与解析。

## 结构

```text
packages/browser/
  MODULE.md              这一页
  spec/                  不变量登记与验收测试（只经入口）
  test/                  实现细节测试
  vendor/devtools-performance-engine/   vendor DevTools 性能引擎（唯一登记的懒加载目标）
  scripts/generate-tools-schema-bundle.mjs   出 32 份工具 schema，喂 check:capabilities-schemas
  src/
    contract/  provides.ts   requires.ts   constants.ts
    types/     browser.ts（可移植）+ cdp / driver / electron / recipes / runtime / session / tools / workspace
    impl/      BrowserTools.ts、BrowserComposition.ts + operations / electron / engines / cdp / session / workspace / policies
    utils/     tuning.ts + 页面脚本、recipe、schema、cdp、electron 等子目录
    index.ts       根入口（`.`）
    contracts.ts   可移植数据入口（`./contracts`）
    renderer.ts    渲染进程入口（`./renderer`）
    electron.ts    Electron 入口（`./electron`）
```

**分层**（登记在 `scripts/ownership/governed-modules.mjs`，上层可以引下层与同层，下层不许引上层）：
`BrowserTools.ts` → `operations/` → `electron/` → `engines/` → `cdp/` `session/` `workspace/` → `policies/` `BrowserComposition.ts`；
utils 在所有层下面。

**改造欠账**：`ElectronBrowserRuntime` 还没有 `bindToolApi`（裁决 B6），两个宿主仍各写一份适配层把 56 个成员
转接成 `ToolBrowserApi`；用户脚本的高风险操作（启用、切 main world、扩大 match）还只靠提示词挡着，
没走审批端口（裁决 B7）。两件都要产品侧同车验证，留给下一轮。
