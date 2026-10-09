# @velaros-ai/velaros/computer

桌面控制：代码面 `velaros:computer` 的 `screenshot`、`move`、`click`、`typeText`、`key`，让模型看用户的主屏、在整台机器上动鼠标和键盘。真正干活的是按需安装的 Python helper 子进程，管它的运行时与只查磁盘的 helper 定位器也在这里；装不装、怎么引导用户装是宿主的事。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import {
  computerOperations,
  createComputerHelperLocator,
  createComputerRuntime,
  type ComputerResourcePort,
} from '@velaros-ai/velaros/computer'
import { VelarComputerModule } from '@velaros-ai/velaros/computer/contracts'

// 宿主的资源来源：内置资源根与启用状态
declare const resources: ComputerResourcePort

// 整个进程一份运行时，第一次用到时才拉起 helper；它结构上就满足空间端口
const locator = createComputerHelperLocator({ resources })
const computer = createComputerRuntime({ resolveHelper: () => locator.resolve() })

// 设置页：永不抛错，不可用时按 reason 引导用户（修复应用资源、给系统权限）
const availability = await computer.ensureAvailable()
if (!availability.available) console.warn(availability.reason, availability.detail)
// 安装器：从随包的 helper 资产目录取源
const helperSource = locator.bundledSourceRoot()

// 挂成模型程序里可以 import 的 velaros:computer：截图经代码面的图片通道交给模型
export const computerModule = createCapabilityModule({
  surface: VelarComputerModule,
  implementation: computerOperations,
  instanceId: 'desktop-computer',
  context: (call) => ({
    abortSignal: call.signal,
    computer,
    attachImage: (image) => call.attach({ type: 'image-data', ...image }),
  }),
})

// 应用退出时停掉 helper
export function shutdown() {
  computer.dispose()
}
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/computer` | Node | `computerOperations`、运行时 `createComputerRuntime`、定位器 `createComputerHelperLocator`、空间端口与注入口 |
| `@velaros-ai/velaros/computer/contracts` | 任何进程 | helper 版本与平台包布局、错误码、环境变量表、上限 `ComputerInputLimits`、可移植数据、模型面 `VelarComputerModule` |

## 约定

- 每个动作先查可用性：helper 没装、被停用、拉不起来或缺系统权限时在做事之前抛 `PERMISSION`，message 引导用户，并明说不要自己用 pip 装依赖；宿主不给 `attachImage` 时 `screenshot` 抛 `PLATFORM`。
- 按截图量的坐标必须带同一次截图的 `snapshotId`，全局坐标写 `coordinateSpace: 'global'` 且不带它，缺了或混用抛 `VALIDATION`；主屏、分辨率、缩放或原点变了，helper 拒绝旧 `snapshotId`，要重新截图。
- helper 只认按 `ComputerResourceLayout` 装好的平台包（`<资源根>/computer-use/computeruse-<平台>-<架构>/`）里的脚本加自包含 Python（兼容 `venv` 布局），缺一样就判资源未就绪，不回落系统 Python、不 `pip install`；开发时可用 `VELAROS_COMPUTER_PYTHON` 指定解释器，`VELAROS_COMPUTER_RESOURCE_ROOT` 一设就整组接管资源根。
- 宿主的安装器从 `bundledSourceRoot()` 取源（包里的 `computer/runtime/`，资产挪到别处时用 `VELAROS_COMPUTER_RUNTIME_SOURCE_ROOT` 指路）：把脚本复制进平台包、携带固定版本的 Python，并在构建时按本平台的 `requirements*.txt` 安装依赖，按 `ComputerHelperVersion` 判断要不要重装。
- 定位不缓存，每次现查磁盘，用户停用立刻生效；`resolve()` 尊重停用开关，`resolveIgnoringDisabled()` 只答物理上装没装。
- 运行时由宿主持有：helper 死了下一次调用重新拉起；`dispose()` 之后不能复用，直接调它报 `COMPUTER_SIDECAR_DISPOSED`，要用就重新造一份。helper 超时没回应抛 `TIMEOUT`，其余运行时失败的码见 `ComputerErrorCodes`。
- 换成自己的 sidecar（`spawnProcess`）要说同一套 stdio 行协议：每行一个 JSON，请求 `{"id","command","payload"}`，应答 `{"id","ok","result"}` 或 `{"id","ok":false,"error":{"code","message"}}`，启动完成先发 `id: 0` 的握手；命令与截图绑定以 `computer/runtime/computer_helper_common.py` 为准。
