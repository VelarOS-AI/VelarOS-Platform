# packages/computer 按仓库标准改造方案

> 对象：`~/Desktop/VelarOS/projects/VelarOS-Platform/packages/computer`（`@velaros-ai/computer` 0.2.16，capabilities 域，桌面控制 Computer Use）。分析基于 HEAD `7c39d5c9`，`packages/computer` 工作区干净。
> 标准：`docs/architecture/module-ownership.md`、ADR 0003 / 0004 / 0007 / 0008，样板 `packages/system`（工具文件、内核挂载写在工具文件末尾）与 `packages/shell-command`（小包的扁平 impl）。
> 方法：只读。工具说明与 schema 由 `plan-mid/scripts/computer-tools-dump.ts` 从源码渲染；缺陷用 `plan-mid/probes/computer-probes.ts`、`computer-epipe.ts`、`computer-restart.ts`、`node-epipe.mjs` 实测（假子进程用 `sh -c`，不碰真 helper）。
> 基线：`packages/computer` 下 `bun test test` 15 pass / 0 fail（6 个文件）。

## 0. 结论先行

1. **规模**：`src/` 15 个 `.ts`、1,918 行，另有随包发布的 Python helper（`runtime/*.py`）1,064 行；3 个类（只有 1 个实现接口）、31 个顶层函数；6 个模型面工具；3 个入口（`./runtime`、`./tools`、`./contracts`，**刻意没有根入口**）共导出 52 个名字，被用 16 个（Desktop 5、Termel 13，发布 fixtures 用的 3 个与 Termel 重叠）。
2. **主要问题**：① 四个真缺陷（第 5 节，全部实测）：`computer:move` 经内核调用（Termel 的做法）一定失败且坐标语义不同；helper 关掉 stdin 或途中退出时，写请求产生的 `EPIPE` 成为**宿主进程的未捕获异常**；helper 在半行输出时崩溃后，下一次启动的握手被残留缓冲吞掉，而启动没有超时，请求永远挂起；Desktop 的插件安装根与停用开关到不了本包的模块级单例。② 同一个操作有两套入参契约（工具 schema 与内核 `parse*`，上限也不同：输入文本 10,000 vs 100,000、按键 100 vs 256），靠 `ComputerToolOperations` 硬映射。③ 工具说明与 README、`Capabilities.ts` 注释在「要不要逐次确认」上互相矛盾；`ComputerToolContext.execution` 没有工具在用。④ 模型看得到的英文：helper 的全部错误信息与 sidecar 报错。
3. **目标**：`src/` 收成五个目录；impl 4 个文件扁平排列、4 层（工具 → 执行 → sidecar → helper 定位）；utils 7 个文件；**入口从 3 个收成 2 个**：`.`（Node 宿主：工具 + 运行时 + 内核）与 `./contracts`（可移植，浏览器可打包）。内核操作改用工具名与工具 schema，删掉 `ComputerToolOperations` 这层映射。
4. **要拍板的**（第 7 节）：合并 `./runtime` 与 `./tools`；内核操作按工具名调用；删 `computer:screen_size`；`computer:move` 也绑定截图；「启用即授权」这句从工具说明挪进卡片与宿主；资源来源改注入；`leftClick` 改名 `click`；中文化 helper 报错。
5. **步骤一句话**：先修 C1–C4（各带回归测试，C1 先按内核接受工具形状修）→ 搬进五目录（入口名暂不变）→ 类加接口、常量与 tuning、英文改中文 → 合同与入口收口（同提交改 Termel 迁移表、fixtures、capability 门）→ 工具面改动单独提交 → 登记治理。

## 1. 现状

### 1.1 目录与职责

| 切片 | 文件（行） | 职责 |
| --- | --- | --- |
| `src/runtime` | `ComputerSidecarManager.ts`(451)、`ComputerSidecarProtocol.ts`(94)、`ComputerHelperResolver.ts`(209)、`ComputerResourceRuntime.ts`(49)、`kernel-module.ts`(327)、`types.ts`(125)、`index.ts`(54) | 拉起 Python helper、JSON Lines 协议、按 id 关联请求、懒启动与释放；按平台与资源根找 helper 与自带 venv；把运行时登记成内核能力 `velaros.computer`（7 个 wire 操作） |
| `src/tools` | `Input.tool.ts`(319)、`Screen.tool.ts`(64)、`Context.ts`(62)、`Types.ts`(70)、`Capabilities.ts`(34)、`Collection.ts`(20)、`index.ts`(11) | 6 个模型面工具、可用性门禁文案、宿主端口 `ToolComputerApi`、能力元数据 |
| `src/contracts` | `index.ts`(28) | 内核操作的权限元数据、工具名 → 内核操作的映射 |
| 包根 `runtime/` | `mac_helper.py`、`win_helper.py`、`linux_helper.py`、`computer_helper_common.py`、`requirements*.txt` | 随包发布的 helper 资产（与 `src/runtime` 同名不同物） |

### 1.2 对外入口：导出了什么、谁在用

| 入口 | 导出（值） | 被用 | 消费方 |
| --- | ---: | ---: | --- |
| `./runtime` | 42（13） | 11 | Desktop：`ComputerSidecarManager`（`execution/Runtime.ts:231` new 一份、另 3 个文件当类型）、`computerHelperResolver`（`resources/AppResourcePluginService.ts:196`、`plugins/computeruse/main/runtime/ComputerUseReadiness.ts:9`）、`ComputerHelperLaunchSpec`。Termel `serve-host`：`ComputerSidecarManager`、`createComputerKernelModule`、`ComputerCapability`、`ComputerKernelModuleVersion`、`ComputerRuntimePort`（3 个文件）、`ComputerAvailability`、`ComputerClickOptions`、`resolveComputerHelper`、`resolveBundledComputerRuntimeSourceRoot`（`computer-installer.ts`） |
| `./tools` | 7（3） | 2 | `computerTools`（Desktop `plugins/computeruse/main/tools/ComputerUse.tool.ts`、Termel `tool-gateway.ts`）、`ToolComputerApi`（Desktop `tools/context/ComputerContextTypes.ts`） |
| `./contracts` | 3（2） | 3 | Termel `tool-gateway.ts` 与测试：`ComputerOperationMetadata`、`ComputerToolOperations`、`ComputerOperation`；`scripts/release/fixtures/host-contract-consumer/{consumer.ts, browser.ts}`（浏览器打包）；`scripts/capabilities/check-packed-consumers.mjs:61-80` |

没用到的 36 个里有 `ComputerHelperResolver` 与 `ComputerResourceRuntimeRegistry` 两个类、`computerResourceRuntime` 单例、协议三个编解码函数、`ComputerObserveCapability / ComputerControlCapability`、`ComputerToolContext`、20 个数据类型。工具名另被 `packages/memory/src/adapter-kernel/EvidenceBridge.ts:311-321` 与 Termel 测试写死。

### 1.3 与别的包的耦合

- 依赖：`@velaros-ai/core`、`@velaros-ai/kernel/contracts/abi`、`zod`、peer `@velaros-ai/agent`（`tool-contract`、`protocol` 类型）。Node 内置模块在 `ComputerSidecarManager.ts`（child_process）、`ComputerHelperResolver.ts`（fs、module、path、url）。
- 仓库门禁与配置钉住的：`scripts/capabilities/capability-owners.mjs`（`entrySubpaths: ['./runtime','./tools']`、`schemaEntry: 'dist/tools/index.js'`）、`scripts/capabilities/check-packed-consumers.mjs`、`scripts/release/check-host-contract-consumer.mjs`（打包 computer，fixture 做浏览器打包）、根 `tsconfig.json` 的 `@velaros-ai/computer/runtime(/*)`、`/tools(/*)` 四条 paths。
- Termel 的 `serve-host/src/tool-gateway.ts:92-205,332-344` 把工具名经 `ComputerToolOperations` 映射到内核操作，**用工具的 zod schema 解析入参后原样交给内核操作**——两套契约就在这里撞上（缺陷 C1）。

### 1.4 写死了别的空间 / 宿主 / 厂商知识的地方

| 位置 | 内容 |
| --- | --- |
| `tools/Context.ts:43-59` | 模型看得到的门禁文案写死了 Desktop 界面：「系统设置 → 隐私与安全性」「设置 → 插件市场」「以 blocking 的用户动作卡呈现该阻塞」、插件名 Computer Use |
| `tools/Context.ts:19-21`、`ComputerHelperResolver.ts:13-19,77-86` | Desktop 构建脚本 `scripts/build/packageComputerUseResources.mjs`、Desktop 插件 id `computeruse`、目录 `computer-use`、Electron `process.resourcesPath` 与 `app.asar.unpacked`、`out/resources` |
| `tools/Screen.tool.ts:13`、`tools/Input.tool.ts:167` | 「网页内容用 browser 工具」「网页内点击用 browser 工具」——工具说明提到别的空间（ADR 0004 定的是「工具描述里不提别的空间」，空间选择是宿主与提示词的事） |
| `README.md` | 「每次实际操作都要过宿主确认流程……确认端口缺席时不得默认放行」，Termel 的 `velaros computer install` |

### 1.5 模块级可变状态

| 位置 | 状态 |
| --- | --- |
| `ComputerResourceRuntime.ts:49` `computerResourceRuntime` | 进程级登记表（额外根、停用集），`@deprecated` 但 `computerHelperResolver` 缺省就用它 |
| `ComputerHelperResolver.ts:209` `computerHelperResolver` | 进程级解析器；`ComputerSidecarManager` 无参构造时也经它 |
| `ComputerSidecarManager.ts:135-136` `stdoutBuffer / stderrBuffer` | 实例状态，但 `teardown()` 不清，跨子进程残留（缺陷 C3） |

Desktop `bootstrap/composition/config.ts:77-79` 只把共享资源安装根与停用集登记到自己的 `appResourceRuntime`，本包的单例一个都看不到（缺陷 C4）；Termel 在 `serve-host/src/host.ts:120-130` 显式传 `resourceRoots`，不受影响。

### 1.6 一个文件多个类、类不实现接口

- `ComputerSidecarManager`、`ComputerHelperResolver` 没有 `implements`；`ComputerRuntimePort`（在 `kernel-module.ts` 里声明）其实就是 sidecar 的接口，只是没挂上。
- `kernel-module.ts` 有 14 个模块级函数（入参解析与服务构造）；`Input.tool.ts` 有 `resolveComputerPoint`、`projectComputerPointResult`；`ComputerSidecarManager.ts` 有 `defaultSpawner`；`ComputerHelperResolver.ts` 有 4 个。
- `ComputerSidecarManager` 的私有方法 `classifyStartError`、`permissionMissingDetail` 不用实例状态。

### 1.7 模型或用户看得到的英文

| 位置 | 原文 | 谁看得到 |
| --- | --- | --- |
| `ComputerSidecarManager.ts:164,281` | `Desktop-control helper script was not found.` | `ensureAvailable().detail`，被 `requireComputerAvailable` 拼进给模型的中文报错括号里 |
| `ComputerSidecarManager.ts:416,418` | `Linux desktop control requires…`、`Desktop control requires Accessibility and Screen Recording permissions.` | 同上 |
| `ComputerSidecarManager.ts:234,242,271,327,332,346` | `Computer sidecar has been disposed`、`Computer sidecar request "…" timed out`、`… exited before becoming ready (code …)`、`Computer sidecar exited.`、`Computer sidecar disposed.` | 工具失败回执 |
| `ComputerSidecarManager.ts:363-367` + `runtime/computer_helper_common.py`、`*_helper.py` | `${code}: ${message}`，message 是 helper 的英文：`The screenshot is unknown or expired; take a new computer:screenshot before clicking`、`Screenshot-local coordinate (…) is outside …` 等 | 模型（点击失败时要据此重新截图） |
| `ComputerSidecarProtocol.ts:42-76` | `Invalid computer-helper response JSON: …` 等 5 句 | 日志与失败回执 |
| `kernel-module.ts:89-221`、`contracts/index.ts:9-15`、`Capabilities.ts:16,33` | `Computer capability input is invalid` + 9 条 `detail`；7 条操作 `reason`；能力 `reason` | 内核调用方、审批与发现界面 |

### 1.8 测试怎么组织

`test/runtime/` 5 个（内核模块、资源登记表、sidecar 截图绑定、两个跑真 Python 的 helper 测试）、`test/tools/` 1 个（坐标）；全部直指 `../../src/...`。`kernel-module.test.ts:100-104` 只核对 `ComputerToolOperations` 的键等于工具名、权限都含 `process:exec`，没核对工具 schema 解析出来的入参内核收不收（C1 因此漏掉）。没有 `spec/`。

## 2. 目标布局

### 2.1 总体

```text
packages/computer/src/
  contract/   provides.ts、requires.ts、constants.ts
  types/      computer.ts（可移植）、protocol.ts
  impl/       ComputerTools.ts（6 个工具、分组、内核挂载）、ComputerInputOperations.ts、ComputerSidecarManager.ts、ComputerHelperLocator.ts
  utils/      protocol.ts、coordinates.ts、availability.ts、helper-paths.ts、process.ts、tool.ts、tuning.ts
  exports/    index.ts、contracts.ts
runtime/      Python helper 资产（位置不变）
```

impl 只有 4 个文件，不分子目录。分层（从上到下）：`ComputerTools.ts` → `ComputerInputOperations.ts`（可用性门禁、坐标解析、结果投影，经宿主端口 `ctx.computer`）→ `ComputerSidecarManager.ts`（运行时）→ `ComputerHelperLocator.ts`（helper 定位）。

**资产路径的坑**：`resolveBundledComputerRuntimeSourceRoot` 用 `new URL('../../runtime', import.meta.url)` 从 dist 文件位置反推包根。现在文件在 `dist/runtime/`，搬到 `dist/impl/` 深度相同，仍指向包根 `runtime/`；以后若再分子目录会指错，所以改成从常量表里的相对路径与 `package.json` 定位，并加一条测试核对该目录里有 `mac_helper.py`。

### 2.2 `types/`

| 文件 | 内容 | 出包 |
| --- | --- | --- |
| `computer.ts`（可移植） | `ComputerAvailability(Reason)`、`ComputerPermissionStatus`、`ComputerScreenSize`、`ComputerScreenshot`、`ComputerMove/Click/Type/KeyResult`、`ComputerClickOptions`（两种坐标空间）、`ComputerCoordinateSpace`、`ComputerHelperLaunchSpec`、`ComputerOperationMetadataEntry` | 随 `./contracts` |
| `protocol.ts` | `ComputerCommand`、`ComputerHelperRequest / Response / Success / Failure` | 不出包 |

### 2.3 `utils/` 与 `tuning.ts`

| 文件 | 来源 |
| --- | --- |
| `protocol.ts` | `ComputerSidecarProtocol.ts` 三个编解码函数 |
| `coordinates.ts` | `Input.tool.ts` 的结果投影与主屏坐标换算 |
| `availability.ts` | `Context.ts` 的 `unavailableMessage`（文案去掉宿主界面路径，见 D5） |
| `helper-paths.ts` | 平台脚本名、资源根推导、venv 解释器路径、包版本读取 |
| `process.ts` | `defaultSpawner`（Node 专属，只被 sidecar 引） |
| `tool.ts` | `defineComputerTool` |
| `tuning.ts` | `ComputerTuning`：`requestTimeoutMs` 15000、`stderrTailChars` 8000、新增 `startupTimeoutMs`（修 C3） |

`kernel-module.ts` 的 14 个解析函数随 D2 删除（内核改用工具 schema 严格解析）。

### 2.4 `exports/`：两个入口

| 入口 | 给谁 | 内容 |
| --- | --- | --- |
| `.` | Node 宿主（Desktop、Termel） | `export * from './contracts.js'`；`computerTools`、`createComputerRuntime`、`createComputerHelperLocator`、`createComputerKernelModule`、`ComputerCapability`；注入面 |
| `./contracts` | 任何进程（host-contract fixture 做浏览器打包） | 常量表 + `types/computer.ts` |

README 说「只装配 sidecar 的宿主不该被迫吃进工具集合的 zod schema」——现有两个宿主都同时用运行时与工具，不存在这种宿主；合并后 `.` 依赖 agent peer，Desktop 与 Termel 本来就有（拍板 D1）。

### 2.5 逐个现有文件的去处

| 现有文件 | 去处 | 理由 |
| --- | --- | --- |
| `tools/Screen.tool.ts`、`tools/Input.tool.ts`、`tools/Collection.ts`、`tools/Capabilities.ts` | `impl/ComputerTools.ts`（定义、能力元数据、分组）；move/click 的 execute 主体 → `impl/ComputerInputOperations.ts`；坐标函数 → `utils/coordinates.ts` | 全部工具定义在一个文件；execute ≤ 4 条（现在 move 5 条、click 9 条） |
| `tools/Context.ts` | 门禁 → `ComputerInputOperations`；文案 → `utils/availability.ts` | — |
| `tools/Types.ts` | `ComputerToolContext`、`ComputerToolComputerApi`（改名，原 `ToolComputerApi`）→ requires；`VelaTool`、`ComputerToolCollection` → provides；`defineComputerTool` → `utils/tool.ts`；`ToolContext` 别名删 | — |
| `tools/index.ts`、`runtime/index.ts`、`contracts/index.ts`（入口部分） | `exports/index.ts`、`exports/contracts.ts` | — |
| `contracts/index.ts`（数据） | `ComputerOperationMetadata` → constants（冻结字面量，不再用 `operation()` 函数与 kernel 类型构造）；`ComputerToolOperations` 删（D2） | 常量表不 import、不放函数 |
| `runtime/ComputerSidecarManager.ts` | `impl/ComputerSidecarManager.ts`（类上方 `ComputerRuntimeApi`，工厂 `createComputerRuntime`）；`defaultSpawner` → `utils/process.ts`；错误码 → constants | 修 C2、C3 |
| `runtime/ComputerHelperResolver.ts` | `impl/ComputerHelperLocator.ts`（`ComputerHelperLocatorApi`，工厂 `createComputerHelperLocator`；`bundledSourceRoot()` 取代 `resolveBundledComputerRuntimeSourceRoot`）；路径函数 → `utils/helper-paths.ts`；单例 `computerHelperResolver` 与 `resolveComputerHelper` 删 | 修 C4 |
| `runtime/ComputerResourceRuntime.ts` | 删；资源来源由注入面 `ComputerResourcePort` 给 | Desktop 传包装 `appResourceRuntime` 的端口 |
| `runtime/ComputerSidecarProtocol.ts` | `utils/protocol.ts` | 纯函数 |
| `runtime/kernel-module.ts` | 挂载 → `impl/ComputerTools.ts` 末尾（`createToolCallableOperations(computerTools, …)`，同 system/office）；运行时直调面见 D3；`ComputerKernelModuleVersion` → constants | 一套入参契约 |
| `runtime/types.ts` | `types/computer.ts`、`types/protocol.ts` | — |
| `velaros-globals.d.ts` | 留在 `src/` 根 | — |

## 3. 合同草案

### 3.1 `contract/provides.ts`

```ts
type VelaTool<TInput> = ToolContractRuntimeSpec<TInput, ComputerToolContext, unknown, ToolPermission>
type ComputerToolCollection = Readonly<Record<ComputerToolName, VelaTool<any>>>
/** 内核能力服务：按工具名调用桌面控制工具（入参先按工具 schema 严格解析，再向宿主要上下文）。 */
interface ComputerCapabilityService extends KernelCallableCapabilityService { readonly tools: ComputerToolCollection }
// 类上方接口，登记：
interface ComputerRuntimeApi {          // Desktop Runtime.ts、Termel host.ts / management-ipc.ts 实际用到的
  isReady(): boolean
  ensureAvailable(): Promise<ComputerAvailability>           // 永不抛
  screenSize(): Promise<ComputerScreenSize>
  screenshot(): Promise<ComputerScreenshot>
  mouseMove(x, y, options?: { durationMs?: number }): Promise<ComputerMoveResult>  // Desktop 浏览器系统指针用 durationMs
  click(x, y, options?: ComputerClickOptions): Promise<ComputerClickResult>        // 原 leftClick（D6）
  typeText(text): Promise<ComputerTypeResult>
  key(keys): Promise<ComputerKeyResult>
  dispose(): void
}
interface ComputerHelperLocatorApi {    // Desktop 插件目录、Termel 安装器
  resolve(): Nullable<ComputerHelperLaunchSpec>              // 尊重停用
  resolveIgnoringDisabled(): Nullable<ComputerHelperLaunchSpec>
  bundledSourceRoot(): string                                // 随包 helper 资产目录
}
```

对外的值：`computerTools`、`createComputerRuntime`、`createComputerHelperLocator`、`createComputerKernelModule`、`ComputerCapability`。

### 3.2 `contract/requires.ts`

```ts
interface ComputerToolContext { abortSignal: AbortSignal; computer: ComputerToolComputerApi }   // 删 execution（没有工具读）
/** 宿主端口（登记 hostPort: 'ComputerToolComputerApi'，hostPortField: 'computer'）；Desktop 与 Termel 都是把运行时薄映射过来。 */
interface ComputerToolComputerApi {
  ensureAvailable(); screenshot(); mouseMove(x, y); click(x, y, options?); typeText(text); key(keys)
  screenSize()                         // 只有保留 computer:screen_size 或 move 继续自己换算时才留（D4），门禁会核对
}
interface CreateComputerRuntimeOptions {
  locateHelper?: () => Nullable<ComputerHelperLaunchSpec>   // 缺省用 createComputerHelperLocator(options.locator)
  locator?: ComputerHelperLocatorOptions
  spawnProcess?: (spec) => ComputerSidecarProcess          // README 承诺可整个替换 sidecar（自定义 sidecar 可以不是 Python）
  requestTimeoutMs?: number; startupTimeoutMs?: number; onLog?: (message: string) => void
}
interface ComputerSidecarProcess { stdin; stdout; stderr; on('error' | 'exit'); kill() }   // stdin 要带 on('error')，见 C2
interface ComputerHelperLocatorOptions { resourceRoots?: string[]; resources?: ComputerResourcePort; platform?: RuntimePlatform }
interface ComputerResourcePort { extraResourceRoots(): string[]; isDisabled(id: 'computeruse'): boolean }
interface CreateComputerKernelModuleOptions {
  resolveContext?: ComputerToolContextResolver   // D2：与 system/office 同构
  runtime?: ComputerRuntimeApi; disposeInjectedRuntime?: boolean   // D3 保留运行时直调面时才要
}
```

### 3.3 `contract/constants.ts`

- 身份：`ComputerToolNames`、`ComputerToolCategoryId = 'computer-control'`、`ComputerCapabilityId = 'velaros.computer'`、`ComputerKernelModuleId = 'velaros.computer.sidecar'`、`ComputerKernelModuleVersion`、`ComputerResourceLayout`（插件 id `computeruse`、目录 `computer-use`、包名前缀 `computeruse`、资产目录 `runtime`）。
- `ComputerOperationMetadata`：按工具名索引的权限与中文 `reason`（D2 后与内核操作名一致）。
- `ComputerErrorCodes`：`sidecarDisposed`、`helperMissing`、`spawnFailed`、`sidecarExited`、`startupTimeout`（新）、`writeFailed`、`protocolInvalid`、`helperError`；`ComputerHelperErrorCodes`：`screen_snapshot_required / stale / unexpected`、`screen_coordinate_out_of_bounds`、`screen_coordinate_space_invalid`、`screen_state_invalid`（现在散在 `SnapshotValidationErrorCodes` 与 Python 里，两边各一份）。
- `ComputerEnvironmentVariables`：`VELAROS_COMPUTER_RESOURCE_ROOT`、`VELAROS_COMPUTER_PYTHON`、`VELAROS_COMPUTER_RUNTIME_SOURCE_ROOT`。
- `ComputerInputLimits`：坐标绝对值 20,000、输入文本 10,000 字、按键串 100 字、连击 3 次、snapshotId 8–128 字（工具说明与 schema 引它；内核改用工具 schema 后不再有第二套 100,000 / 256）。

### 3.4 要删的现有导出与替代

| 现有 | 替代 |
| --- | --- |
| `@velaros-ai/computer/runtime`、`/tools` | `@velaros-ai/computer` |
| `new ComputerSidecarManager(options)`、`ComputerRuntimePort` | `createComputerRuntime(options)`、`ComputerRuntimeApi` |
| `computerHelperResolver`、`resolveComputerHelper(opts)`、`resolveBundledComputerRuntimeSourceRoot()`、`ComputerHelperResolver`、`ComputerResourceRuntimeRegistry`、`computerResourceRuntime` | `createComputerHelperLocator({ resourceRoots, resources })` 的 `resolve / resolveIgnoringDisabled / bundledSourceRoot` |
| `ToolComputerApi`、`ToolContext` | `ComputerToolComputerApi`、`ComputerToolContext` |
| `ComputerToolOperations`、`ComputerOperation` | 内核操作名就是工具名（D2），`ComputerToolName` |
| `leftClick` | `click`（D6） |
| `encodeComputerRequest / decodeComputerResponse / drainResponseLines`、`ComputerObserveCapability / ComputerControlCapability`、协议类型 | 不出包 |

## 4. 工具面

### 4.1 全部模型面工具

| 工具 | 做什么 | 字段 | 说明 / schema 字符 | execute 语句 | 权限 |
| --- | --- | --- | --- | ---: | --- |
| `computer:screenshot` | 截主屏，图作为模型可见图片，返回几何与 `snapshotId` | 无 | 353 / 33 | 4 | screen:capture |
| `computer:screen_size` | 主屏逻辑宽高、缩放、原点 | 无 | 145 / 33 | 3 | screen:capture |
| `computer:move` | 移动指针不点击 | x、y、coordinateSpace（primary-display 缺省 / global） | 206 / 741 | 5 | input:control |
| `computer:click` | 点击；主屏坐标必须带同一截图的 `snapshotId` | x、y、coordinateSpace、snapshotId、button、count | 409 / 1,327 | 9 | input:control |
| `computer:type` | 在焦点处输入文本 | text（≤10,000） | 175 / 136 | 3 | input:control |
| `computer:key` | 按键或组合键 | keys（≤100） | 208 / 183 | 3 | input:control |

- 定义分在 `Screen.tool.ts`、`Input.tool.ts` 两个文件；`defineComputerTool` 在两处调用；类别统一 `computer-control`。
- schema 严格度不一：`click` 的两个分支 `.strict()`，其余 `z.object`（多余字段静默丢掉）。
- 能力元数据：控制档写 `process: { execution: 'dangerous' }`，agent 只拿它当检索提示，不触发审批；`Capabilities.ts:20-21` 注释「Every tool using this routes through the confirmation flow」与实际不符。

### 4.2 简化候选

| 候选 | 判定 | 理由 |
| --- | --- | --- |
| `computer:screen_size` | **删**（D4） | 截图结果本来就带 `displayWidth / displayHeight / originX / originY / scaleFactor / displayId`，而点击主屏坐标又必须先截图拿 `snapshotId`；它只剩「不看图拿几何」，只对全局坐标有用，模型几乎用不到；内核的运行时方法 `screenSize` 保留 |
| `computer:move` | 保留，改契约（D4） | 悬停是唯一能力；但主屏坐标现在不绑截图、自己用 `screenSize` 换算原点，和 click 的严格绑定不一致；改成与 click 同一套（主屏坐标带 `snapshotId`，由 helper 校验后换算） |
| 其余 4 个 | 保留 | 各有唯一能力 |

### 4.3 提示词问题

| # | 位置 | 原文 | 问题 | 改后 |
| --- | --- | --- | --- | --- |
| P1 | move、click、type、key 的注意 | 「启用 Computer Use 即视为授权，执行不再逐次确认；仅受系统权限限制。」×4 | 重复 4 次；是宿主的授权策略，模型据此做不了任何决定；与 README「每次实际操作都要过宿主确认」、`Capabilities.ts` 注释冲突 | 从说明里删；授权口径写进卡片「失败语义」与 Desktop 的 Computer Use 设置说明（D5） |
| P2 | screenshot 注意 | 「返回屏幕几何，并把截图作为图片直接呈现给模型（base64 不进文本，避免上下文膨胀）。」 | 括号里是实现细节 | 「返回屏幕几何与 snapshotId，截图作为图片交给你。」 |
| P3 | screenshot 用法 + 注意两条 + click 禁止 + click 用法 + click 注意 | snapshotId 的规则说了 6 遍 | 冗余 | screenshot 一句「坐标按截图左上角算，点击时原样带上本次的 snapshotId」；click 一句「主屏或布局变了会拒绝，重新截图」 |
| P4 | screenshot 禁止、click 禁止 | 「网页内容用 browser 工具，不要用桌面截图替代。」「网页内点击用 browser 工具」 | 提到别的空间 | 删（是否同意 ADR 0004 的口径推广到 computer，D5） |
| P5 | screen_size 适合 | 「点击前需要屏幕宽高、缩放或原点。」 | 点击用截图局部坐标，不需要这些 | 随工具删除 |
| P6 | move 用法 | 「截图定位传 x、y 即可；只有显式使用虚拟桌面全局坐标时传 coordinateSpace=global。」 | 说「截图定位」却不要 snapshotId，布局变了照样移过去 | 与 click 同口径（D4） |
| P7 | key 用法 + keys 参数说明 | 「传按键序列，用 + 连接。」与「按键序列，组合键用 + 连接。示例：enter、esc、tab、cmd+a、ctrl+c。」 | 重复 | 用法删，参数说明保留示例 |
| P8 | 门禁报错（`Context.ts:55-59`） | 「……请【不要】用 pip、shell……以 blocking 的用户动作卡呈现该阻塞……」 | 写死 Desktop 界面名词；「blocking 的用户动作卡」是 Desktop 的卡片概念 | 「桌面控制插件没有安装（原因）。不要自己安装 Python 依赖或搭环境；请用户安装桌面控制插件后再试。」界面引导由宿主补 |

模型看得到的英文见 1.7；最关键的是点击失败时 helper 返回的英文（模型要据此决定重新截图），改中文或由 sidecar 按 `ComputerHelperErrorCodes` 映射成中文（D7）。

## 5. 实现层缺陷（C1–C4 实测）

| # | 位置 | 现象 | 复现 |
| --- | --- | --- | --- |
| C1 | `contracts/index.ts:21-28` + `kernel-module.ts:110-112,250-256` + Termel `tool-gateway.ts:332-344` | `computer:move` 经内核调用必失败：工具 schema 给 `coordinateSpace` 填了缺省值 `primary-display`，内核 `mouse_move` 只收 `x、y` 两个键，报「unexpected key」；即使收了，工具的 x、y 是主屏局部坐标（加原点），内核的是全局坐标，多显示器时指针会去错地方 | `computerTools['computer:move'].schema.safeParse({x:10,y:20})` → `{"x":10,"y":20,"coordinateSpace":"primary-display"}`；交给内核 `mouse_move` → `VALIDATION`，`details = {"field":"coordinateSpace","detail":"unexpected key; allowed: x, y"}` |
| C2 | `ComputerSidecarManager.ts:257`（`this.child!.stdin.write`）与 `teardown()` 的 `stdin.end()` | stdin 没有 `'error'` 监听；helper 关掉输入或途中退出、而 `exit` 事件还没到时，写请求的 `EPIPE` 是异步错误事件，`try/catch` 接不住，成为宿主进程的**未捕获异常**（Electron 主进程会弹错误框） | 假 helper：握手后 `exec 0<&-` 保持存活，发一个请求 → Bun 下 `UNCAUGHT EPIPE: broken pipe`；同样的写法在 Node 下 `UNCAUGHT EPIPE write EPIPE`（`node-epipe.mjs`） |
| C3 | `ComputerSidecarManager.ts:135-136,270-340,423-438` | `teardown()` 不清 `stdoutBuffer`，上一个 helper 死在半行时，残片粘到下一个 helper 的握手行前，握手解析失败被丢弃；`start()` 没有启动超时，请求的超时计时器又是在 `await this.start()` 之后才设——请求**永远挂起** | 第一个假 helper 写 `{"id":1,"ok":tr` 后退出，第二个正常握手：第一个请求 `COMPUTER_SIDECAR_EXITED`，第二个请求 3 秒窗口内不 settle（请求超时设的 800 ms 从未生效）。helper 卡在导入阶段不打握手，也是同样的挂起 |
| C4 | `ComputerHelperResolver.ts:72-88,120,209`、`ComputerSidecarManager.ts:143` 与 Desktop `bootstrap/composition/config.ts:77-79`、`resources/AppResourcePluginService.ts:196,229`、`execution/Runtime.ts:231` | Desktop 的共享资源安装根与停用集只进了 Desktop 自己的 `appResourceRuntime`；本包单例的根只有环境变量根、`resourcesPath`、`out/resources`。按代码推断：插件市场装到共享资源根的 Computer Use，Desktop 插件目录判为未安装、工具不注册，`new ComputerSidecarManager()` 也找不到 helper | 探针：注入登记表的定位器根为 `["/opt/host-shared-resources", …]`，默认单例只有 `[".../out/resources"]`；Desktop 表现需真机确认 |
| C5 | `tools/Types.ts:53`、`README.md`、`Capabilities.ts:20-21` | `ComputerToolContext.execution` 声明为「确认流程用」，没有工具读它；README 与注释说每次动作都确认，代码与工具说明说不确认 | 代码走读 |
| C6 | `kernel-module.ts:276-291` | 内核能力服务除 `invoke` 外把运行时方法（含 `dispose`）直接挂在服务对象上：拿到服务的模块可以绕过 wire 入参门与权限元数据直接点击，或把宿主注入的运行时 `dispose` 掉（即使 `disposeInjectedRuntime` 为 false） | 代码走读；D3 |
| C7 | `tools/Context.ts:28-33` | 每个动作前 `ensureAvailable()` 都发一次 `check` 往返（含权限探测），每次点击多一次 IPC | 代码走读；可按宿主给的时效缓存 |

## 6. 步骤与风险

每步的全绿口径：`cd packages/computer && bun test test`（15 条只许挪位不许减）、`bun run --cwd packages/computer typecheck`、`bun run --cwd packages/computer build`、仓根 `bun run typecheck`、`bun run check:capabilities-schemas`、`bun run check:capabilities-arch`、`bun run check:host-contract-consumer`（打包 computer、浏览器打包 `./contracts`）、`bun run check:code-style`；工具面不变的步骤先落 6 个工具的说明与 schema 快照。

| 步 | 做什么 | 保持全绿 | 规模 |
| --- | --- | --- | --- |
| 1 修缺陷 | C2（stdin 与 child 的 `error` 都接住，写失败按 `writeFailed` 拒绝当前请求并 teardown）、C3（`teardown` 清两个缓冲；启动超时进 tuning；请求超时从发请求前开始算）、C1（先让内核 `mouse_move` 接受与工具相同的形状、按坐标空间换算，保持现有映射，待 D2 再统一）各一个提交，带回归测试（用 `sh -c` 假子进程） | 新测试先红后绿 | 约 200 行 |
| 2 搬家 | 按 2.5 进五目录，入口名暂不变（`package.json` 指向 `dist/exports/runtime.js` 等过渡文件）；同提交改 `capability-owners.mjs` 的 `schemaEntry`、根 `tsconfig.json` paths | 导出名不变 | 15 次搬家 |
| 3 达标 | 类加接口、纯函数进 utils、常量与 tuning、英文改中文（含 Python helper 报错，或 sidecar 按码映射） | 快照：仅说明里的数字改引常量，字节不变 | 约 800 行 |
| 4 合同与入口收口（破坏性） | `contract/` 三文件；入口收成 2 个；内核改按工具名（D2）；资源来源改注入（修 C4）；同提交改 `scripts/release/fixtures/host-contract-consumer/{consumer.ts, browser.ts}`、`scripts/capabilities/check-packed-consumers.mjs`、`docs/generated/package-catalog.json`；Termel `tool-gateway.ts` 的映射表与 Desktop 的 4 处 import 进迁移表；版本 0.3.0 | `check:host-contract-consumer` | Desktop 6 个文件、Termel 6 个文件 |
| 5 工具面改动（单独提交，拍板后） | 删 `computer:screen_size`、move 绑定截图、P1–P8 文案、schema 全部严格；同步 `packages/memory/src/adapter-kernel/EvidenceBridge.ts` 的工具名分支 | 快照按差量报告更新 | — |
| 6 登记治理 | `governed-modules.mjs` 条目（`toolsFile: 'src/impl/ComputerTools.ts'`、`toolDefiner: 'defineComputerTool'`、`hostPort: 'ComputerToolComputerApi'`、`hostPortField: 'computer'`、`browserSafeEntries: ['contracts.ts']`、`environmentTable: 'ComputerEnvironmentVariables'`、`tuning: 'tuning.ts'`、4 层）；`MODULE.md`、`spec/` | `check:module-ownership` 零条 | — |

不变量候选：① `ensureAvailable` 永不抛，环境问题一律是结构化结果（测试）；② 主屏局部坐标的点击（D4 后含移动）必须带同一截图的 `snapshotId`，主屏、尺寸、缩放、原点任一变化就拒绝（测试，沿用 Python 用例）；③ 工具与内核用同一份入参 schema，未知字段拒绝（测试）；④ helper 进程死亡后状态机回到空闲，下一次请求重新拉起；启动有超时（测试）；⑤ helper 的管道错误不会成为宿主进程的未捕获异常（测试）；⑥ helper 定位不联网、不装依赖，只认自包含 venv 或显式 `VELAROS_COMPUTER_PYTHON`（测试）；⑦ `./contracts` 的引用链不碰 Node 模块（门禁）。

**风险与共享文件**：根 `tsconfig.json`（另一实例正在改）、`scripts/capabilities/capability-owners.mjs`（office 方案也改）、`scripts/ownership/governed-modules.mjs`、`scripts/release/fixtures/host-contract-consumer/`（model 与 agent 的改造也改这批 fixtures，三路要串行）、`docs/generated/package-catalog.json`。helper 的 Python 测试依赖本机 Python（现有两个测试已如此）。

## 7. 需要拍板的项

- **D1 入口合并**：`./runtime` + `./tools` → `.`，保留 `./contracts`；版本 0.3.0。
- **D2 内核操作按工具名调用**：内核模块改成与 system、office 同一个 `createToolCallableOperations(computerTools, resolveContext, …)`，入参就是工具 schema，删 `ComputerToolOperations` 与 14 个手写解析函数；Termel `tool-gateway` 改为按工具名路由（与 system 路由同一写法）。
- **D3 内核服务的运行时直调面**：删掉服务对象上直接挂的运行时方法（尤其 `dispose`），宿主要直调就自己持有 `ComputerRuntimeApi`；Termel 的 `management-ipc.ts` 目前持有的就是运行时本身，不经服务。
- **D4 工具面**：删 `computer:screen_size`；`computer:move` 的主屏坐标也要 `snapshotId`。
- **D5 授权口径与文案**：「启用即授权、不逐次确认」确认为产品决定并写进卡片与宿主设置说明，工具说明删掉；README 改正；工具说明不再提 browser 空间；门禁文案去掉 Desktop 界面名词。
- **D6 运行时方法 `leftClick` 改名 `click`**（它本来就接受右键、中键）。
- **D7 helper 报错中文化**：改 Python 文案，还是 sidecar 按 `ComputerHelperErrorCodes` 翻成中文（后者不用动 helper 资产，推荐）。
