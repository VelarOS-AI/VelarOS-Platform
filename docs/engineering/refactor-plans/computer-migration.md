# `@velaros-ai/computer` 0.2.16 → 0.3.0 迁移表

这是一次**破坏性**发布：3 个入口收成 2 个，13 个名字从对外面上消失，宿主端口与运行时各改一处形状，
模型面从六个工具减到五个、`computer:move` 改成与点击同一套截图绑定契约。

- 仓内消费点**本轮已全部改完**。
- 产品仓的调用点**本轮不改**，只列进第 6 节，由各产品仓自己按这张表改。
- 判断口径：消费点 = 直接 `import … from '@velaros-ai/computer*'` 的源文件数（注释与文档不计）。

改造方案见 `computer.md`（§2 目标布局、§3.4 要删的导出与替代、§4 工具面）；裁决见
`../foundation-pending-decisions.md` 第五节 C1、C5、C6；仓库标准见
`../../architecture/module-ownership.md`。

---

## 1. 入口前后对照

| 旧入口（3） | 新入口（2） | 说明 |
| --- | --- | --- |
| `./runtime` | `.` | 运行时、helper 定位器、内核挂载；它与 `./tools` 的依赖闭包本来就重叠 |
| `./tools` | `.` | 五个工具与工具上下文 |
| `./contracts` | `./contracts` | 常量表与可移植数据；渲染进程可加载，整条链不碰 Node |
| —（本来没有根入口） | `.` | 0.3.0 起有根入口，Node 宿主只认它 |

新入口的值一共 16 个：

| 入口 | 值 |
| --- | --- |
| `.` | `computerTools`、`createComputerRuntime`、`createComputerHelperLocator`、`createComputerKernelModule`、`ComputerCapability`，加 `contract/constants.ts` 的 11 张常量表与身份字符串 |
| `./contracts` | 同一批常量表（`.` 的可移植子集），没有别的值 |

`browserSafeEntries` 是 `contracts.ts`。

---

## 2. 新增的名字（1）

| 新名 | 它顶替了谁 |
| --- | --- |
| `ComputerMoveOptions`（连同 `ComputerMoveModifiers`、`ComputerGlobalMoveOptions`、`ComputerPrimaryDisplayMoveOptions`） | 原先 `mouseMove` 的第三个参数是匿名的 `{ durationMs?: number }`；移动改成与点击同一套坐标契约后，它要能表达坐标空间与截图绑定 |

---

## 3. 有替代的旧名（10）

### 3.1 类与模块级实例 → 工厂

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `new ComputerSidecarManager(o)` | `createComputerRuntime(o)`；类型位用 `ComputerRuntimeApi` | `.` | 4（测试，已改完） | Desktop 4、Termel 3 |
| `ComputerHelperLocator` / `ComputerHelperResolver`（类） | `createComputerHelperLocator(o)`；类型位用 `ComputerHelperLocatorApi` | `.` | 0 | — |
| `computerHelperResolver`（进程级缺省实例） | `createComputerHelperLocator({ resources })`——宿主把自己的插件登记表包成 `ComputerResourcePort` 传进来，装在共享资源根的插件才看得见 | `.` | 0 | Desktop 2 |
| `resolveComputerHelper(o)` | `createComputerHelperLocator(o).resolve()` | `.` | 1（测试，已改完） | — |
| `resolveBundledComputerRuntimeSourceRoot()` | `createComputerHelperLocator().bundledSourceRoot()` | `.` | 1（测试，已改完） | Termel 1 |

### 3.2 换了名字

| 旧名 | 新名 | 新入口 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- | --- |
| `ToolComputerApi` | `ComputerToolComputerApi` | `.` | 1（测试，已改完） | Desktop 1 |
| `ToolContext`（本包的那个） | `ComputerToolContext` | `.` | 0 | — |
| `ComputerHelperResolverOptions` | `ComputerHelperLocatorOptions` | `.` | 0 | — |
| `ComputerRuntimeCapabilityService` | `ComputerCapabilityService` | `.` | 0 | — |
| 运行时与端口上的 `leftClick(x, y, options)` | `click(x, y, options)`——它本来就接受右键、中键，名字里的 left 是错的 | `.` | 3（已改完） | Desktop 1、Termel 1 |

---

## 4. 已删、没有替代的名字（3）与形状变化（3）

### 4.1 不再出包的名字

| 旧名 | 为什么删 |
| --- | --- |
| `encodeComputerRequest` / `decodeComputerResponse` / `drainResponseLines` | helper 行协议的编解码，是 utils 函数：仓库标准里 utils 不出包。要跟 helper 说话就用 `createComputerRuntime()` |
| `ComputerObserveCapability` / `ComputerControlCapability` | 两档能力声明是工具定义的内部数据，没有任何公开签名用到 |
| `ComputerToolOperations` | 工具名到内核操作名的恒等映射表：内核操作名就是工具名，这张表只剩仪式感。要枚举操作名用 `ComputerToolNames` 或 `ComputerOperationMetadata` 的键 |
| `ComputerCommand`、`ComputerHelperRequest` / `Response` / `Success` / `Failure` | helper 行协议的形状，没有公开签名用到 |

### 4.2 形状变化

| 名字 | 变化 | 影响 |
| --- | --- | --- |
| `ComputerToolComputerApi`（宿主端口） | 去掉 `screenSize()`；`mouseMove` 多一个 `options?: ComputerMoveOptions` | 模型面不再有「不看图拿屏幕几何」这个操作，工具也不再自己按屏幕几何换算坐标，端口上就没有 `screenSize` 的消费方了（门禁逐方法核对）。宿主自己的界面要屏幕几何，用运行时的 `screenSize()`，那个方法保留 |
| `ComputerRuntimeApi` / `ComputerRuntimePort` | `leftClick` 改名 `click`；`mouseMove` 的第三个参数由 `{ durationMs?: number }` 变成 `ComputerMoveOptions`（`durationMs` 仍在，多了坐标空间与绑定） | Desktop、Termel 的适配层各改两行 |
| `ComputerMoveResult` | 多了可选的 `coordinateSpace`、`displayId`、`snapshotId` | 与点击回执对齐；旧字段一个没变 |

### 4.3 helper 线协议（`runtime/*.py`，随包资产）

`mouse_move` 现在与 `left_click` 收同一套坐标判别：`coordinateSpace` 省略或为 `'global'` 时按全局坐标；
为 `'primary-display'` 时必须带 `snapshotId`，由 helper 校验绑定后换算成全局坐标。
共享模块里的 `parse_click_coordinate_binding` 随之改名 `parse_pointer_coordinate_binding`。
`ComputerKernelModuleVersion` 从 `0.2.8` 提到 `0.3.0`，宿主的安装器按它判断随包 helper 资产要重装。

---

## 5. 模型面变化（会改发给模型的字节）

工具从六个减到五个。逐字节快照 `packages/computer/test/tool-surface-snapshot.json` 已按新形态重绑，
差量只有下面五处。

| # | 位置 | 原文 | 新文 |
| --- | --- | --- | --- |
| 1 | `computer:screen_size` 整个工具 | 「描述：查询主屏幕逻辑尺寸与缩放。适合：点击前需要屏幕宽高、缩放或原点。……注意：返回逻辑宽高、scaleFactor 与原点。」 | 整个删除（C5）。截图结果本来就带 `displayWidth / displayHeight / originX / originY / scaleFactor / displayId`，而点主屏坐标又必须先截图拿 `snapshotId`；它只剩「不看图拿几何」这一个用途 |
| 2 | `computer:move` 的用法、禁止、示例与 schema | 用法：「截图定位传 x、y 即可；只有显式使用虚拟桌面全局坐标时传 coordinateSpace=global。」禁止：「点击用 computer:click。」示例：`{"x":640,"y":400}`；schema 的 primary-display 分支只有 `x`、`y`、`coordinateSpace`，且不是 strict | 用法：「移动到截图内位置：传 x、y 和同一次 computer:screenshot 返回的 snapshotId。」「显式全局坐标传 coordinateSpace=global，且不要传 snapshotId。」禁止：「点击用 computer:click；不要省略或复用其他截图的 snapshotId。」示例：`{"x":640,"y":400,"snapshotId":"screen_example_snapshot_01"}`；两个分支都 strict，primary-display 分支必填 `snapshotId`（C5） |
| 3 | `computer:move` 的注意 | 「启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。」 | 「helper 会在真实移动前校验截图绑定；主屏或布局变化后旧 snapshotId 会被拒绝，请重新截图。」 |
| 4 | `computer:click`、`computer:type`、`computer:key` 的注意 | 三处各有一条「启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。」 | 三处全部删除（C6）。授权口径是产品决定，模型据此做不了任何决定；它现在写在 `MODULE.md` 的「失败语义」与宿主的设置说明里 |
| 5 | `computer:screenshot` 的用法与三条注意 | 用法：「……原样传给随后基于该截图坐标执行的 computer:click。」注意①：「返回屏幕几何，并把截图作为图片直接呈现给模型（base64 不进文本，避免上下文膨胀）。」注意②③只提 `computer:click` 与「点击前」 | 用法与注意②改成同时点名 `computer:move` 与 `computer:click`，注意③改成「动作执行前」；注意①改成「返回屏幕几何与 snapshotId，截图本身作为图片交给你。」——括号里的 base64 是实现细节，而且门禁禁止工具说明里出现裸数字（`base64` 的「64」被判为裸数字） |

「启用即授权」在本包里现在只出现在两处非模型面：`ComputerControlCapability` 上方的代码注释，
与 `MODULE.md` 的「失败语义」。README 与宿主设置说明里的口径要由产品仓一并对齐（C6 的产品侧部分）。

---

## 6. 产品仓要改的调用点

### 6.1 VelarOS-Desktop（8 个文件 + 依赖版本）

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `src/plugins/computeruse/main/tools/ComputerUse.tool.ts` | `/tools`: `computerTools` | `@velaros-ai/computer` |
| `src/plugins/computeruse/main/runtime/ComputerUseReadiness.ts` | `/runtime`: `computerHelperResolver` | `createComputerHelperLocator({ resources })` from `@velaros-ai/computer`，`resources` 包住 Desktop 自己的 `appResourceRuntime`（这样插件市场装到共享资源根的 Computer Use 才看得见，方案 C4） |
| `src/main/resources/AppResourcePluginService.ts` | `/runtime`: `computerHelperResolver`、`ComputerHelperLaunchSpec` | 同上；类型也可从 `/contracts` 取 |
| `src/main/tools/context/ComputerContextTypes.ts` | `/tools`: `ToolComputerApi` | `ComputerToolComputerApi` from `@velaros-ai/computer` |
| `src/main/agent/context/ComputerTools.ts` | `/runtime`: `ComputerSidecarManager`（类型位），适配层实现 `screenSize` 并把 `click` 转发到 `leftClick` | 类型位改 `ComputerRuntimeApi`；**删掉 `screenSize` 那一行**（端口上没有了）；`click: (x, y, options) => requireRuntime().click(x, y, options)`；`mouseMove: (x, y, options) => requireRuntime().mouseMove(x, y, options)` |
| `src/main/agent/context/ToolContext.ts` | `/runtime`: `ComputerSidecarManager`（类型位） | `ComputerRuntimeApi` |
| `src/main/bootstrap/RuntimeTypes.ts` | `/runtime`: `ComputerSidecarManager`（类型位） | `ComputerRuntimeApi` |
| `src/main/execution/Runtime.ts` | `/runtime`: `new ComputerSidecarManager(...)` | `createComputerRuntime(...)` |
| `scripts/checks/toolDescriptionBudget.mjs` | `['@velaros-ai/computer/tools', ['computerTools']]` | `['@velaros-ai/computer', ['computerTools']]` |
| `scripts/build/packageComputerUseResources.mjs` | `import.meta.resolve('@velaros-ai/computer/runtime')` | `import.meta.resolve('@velaros-ai/computer')` |
| `package.json` / `bun.lock` | `^0.2.16` | `^0.3.0` |

`scripts/build/mainBundledPlatformPackages.json` 与 `packages/arch-guard-velaros/src/project/architecturePackageChecks.mjs`
只写包名，不受入口变化影响。Computer Use 的界面文案（「启用即授权」口径）随 C6 一并对齐。

### 6.2 VelarOS-Termel（6 个文件 + 依赖版本）

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `packages/serve-host/src/host.ts` | `/runtime` | 同名值全在 `@velaros-ai/computer` |
| `packages/serve-host/src/management-ipc.ts` | `/runtime`：持有运行时本身 | 同上；`leftClick` 改 `click` |
| `packages/serve-host/src/computer-installer.ts` | `/runtime`：helper 定位与随包资产目录 | `createComputerHelperLocator()` 的 `resolve / resolveIgnoringDisabled / bundledSourceRoot` |
| `packages/serve-host/src/tool-gateway.ts` | `/contracts`（含 `ComputerToolOperations`）、`/runtime`: `ComputerCapability`、`/tools`: `computerTools` | 三处并成 `@velaros-ai/computer`（可移植数据仍可走 `/contracts`）；**`ComputerToolOperations` 已删**，按工具名路由即可（两边本来就恒等） |
| `packages/serve-host/test/host-extension.e2e.test.ts` | `/runtime`: `ComputerClickOptions`、`ComputerRuntimePort` | `@velaros-ai/computer`；实现 `ComputerRuntimePort` 的替身要把 `leftClick` 改成 `click` |
| `packages/serve-host/test/tool-discovery.test.ts` | `/contracts`: `ComputerOperationMetadata`；`/runtime`: `ComputerCapability` | 合到 `@velaros-ai/computer`；断言里的六个工具改五个 |
| `packages/serve-host/package.json` / `bun.lock` | `0.2.16` | `0.3.0` |

### 6.3 VelarOS-Workbench / VelarOS-Extension（0 个文件）

两个仓都不依赖 `@velaros-ai/computer`。

### 6.4 Platform 仓内（本轮已改完）

| 文件 | 改了什么 |
| --- | --- |
| `packages/computer/test/**`（10 个文件） | 入口改根入口；`new ComputerSidecarManager` → `createComputerRuntime`；`leftClick` → `click`；`ComputerToolOperations` 换成 `ComputerOperationMetadata`；move 的用例改成截图绑定契约 |
| `packages/ui/src/conversation/tool-render/toolTargetSummary.ts`、`tests/ui/toolTargetSummary.test.ts` | 工具卡目录里 `computer:screen_size` 一行删掉 |
| `scripts/capabilities/capability-owners.mjs` | computer 的 `entrySubpaths` 改 `['.', './contracts']`、`schemaEntry` 改 `dist/index.js` |
| `scripts/capabilities/check-packed-consumers.mjs`、`scripts/release/fixtures/host-contract-consumer/{consumer,browser}.ts` | `ComputerToolOperations` → `ComputerToolNames` |
| 根 `tsconfig.json` | `@velaros-ai/computer/runtime`、`/tools` 四条 paths 收成 `@velaros-ai/computer` 与 `/*` 两条 |
| `scripts/ownership/governed-modules.mjs` | computer 摘掉 `status: 'migrating'`（燃尽归零），层注释「六个」改「五个」 |
| `docs/generated/package-catalog.json`、`bun.lock` | computer 版本与入口清单 |

---

## 7. 本轮**没有**做完的（已知偏离方案）

| # | 事项 | 为什么留到下一轮 |
| --- | --- | --- |
| 1 | D3：内核能力服务上仍然挂着运行时直调面（含 `dispose`）。拿到服务的模块可以绕过 wire 入参门直接点击，或把宿主注入的运行时 `dispose` 掉 | 本轮拍板只点名了 C5、C6；删它要同时改 Termel 的 `management-ipc.ts` 与 `tool-gateway.ts` 的持有方式，属于另一次接口改形 |
| 2 | 方案 §4.3 的 P4：工具说明里仍提 `browser` 工具（`computer:screenshot` 的禁止、`computer:click` 的禁止各一处） | 那是 ADR 0004「工具描述里不提别的空间」推广到全部能力包的事（总纲 S12），要和 browser、office 一起改，单独一轮 |
| 3 | D7：helper 的英文报错由 sidecar 按 `ComputerHelperErrorCodes` 翻中文——码表与翻译已在，个别 helper 文案仍是英文原文 | 文案层，不影响判定 |
| 4 | C7：每个动作前都发一次 `check` 往返 | 性能优化，要先定「可用性结果能缓存多久」 |
| 5 | `packages/memory/src/utils/capture.ts` 里 `case 'computer:screen_size'` 变成死分支 | memory 包这一轮由另一路在改，不并行动它；那一路收工后删这一个 case 即可（不删也只是死代码，不影响行为） |
| 6 | `packages/agent/test/modelInputCompatibility.test.ts` 用 `computer:screen_size` 当合成的工具名 fixture | 那是 agent 包自己的合成数据，不依赖本包，agent 那一路顺手改名即可 |
