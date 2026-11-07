# @velaros-ai/velaros/computer

桌面控制：`velaros:computer` 提供主屏/窗口观察、UI 控件语义、键鼠输入、滚动拖拽与有界录像。原生实现复用 PyAutoGUI、pywinauto、PyObjC、python-xlib 与 PyAV；Desktop 在构建时准备自包含 Python，用户运行时不安装依赖。

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

- `capabilities` 报告实际后端与限制，`windows` 返回进程内不透明窗口 id，`focusWindow` 聚焦该窗口。Windows 用 pywinauto UIA；macOS 用 Quartz/Accessibility；Linux 窗口能力限 X11，未随包提供 AT-SPI 控件树，Wayland 不冒充完整桌面控制。
- `screenshotWindow({ windowId })` 经同一图片通道交图，返回窗口 `snapshotId`；后续坐标写 `coordinateSpace: 'window'`。窗口移动、缩放或身份变化就拒绝旧绑定。Windows/X11 抓取屏幕可见区域，遮挡部分可能包含其他窗口；macOS 用系统窗口捕获。`capabilities.captureMode` 说明差异。
- `scroll({ at, deltaX, deltaY })` 用滚轮刻度，正数向右/下，每轴绝对值不超过 100。`drag({ from, to, durationMs, button })` 先校验两端，原子执行并在异常时松开按钮，100–3000ms。Windows 横向滚轮使用 pywin32 的 HWHEEL，绕过 PyAutoGUI 将横向转发为纵向的实现。
- `mouseDown`/`mouseUp` 与 `keyDown`/`keyUp` 管理当前 helper 自己持有的输入，按下后最多 5000ms 自动释放；必须在 `try/finally` 中配对。`releaseInputs` 可幂等清理全部持有项；正常进程关闭也清理。进程被操作系统强制终止无法保证清理，宿主退出先给 EOF 清理宽限。
- `uiTree` 默认深度 6、200 节点，上限 12、500，并有 3 秒遍历预算；`truncated`/`warnings` 保留不完整结果。节点只提供名字、角色、自动化 id、几何和启用状态，不读取输入值。`invokeElement`/`setElementValue` 只接受同次树的身份（缓存最多 8 棵、30 秒过期），调用原生 Invoke/Value 或 AXPress/AXValue，失败不降级为坐标点击。
- Windows `typeText` 复用 pywinauto 的字面 Unicode KeyAction，支持中文、emoji、空白和特殊字符，不经过快捷键表达式，也不改剪贴板。Linux 原有 PyAutoGUI 文字输入仍受键盘布局与字符集限制。
- `record({ path, durationMs, fps, windowId? })` 流式编码 MPEG-4/MP4，无音频，100–5000ms、1–10fps，帧上限 16MP。路径必须是不存在的绝对路径；编码成功后原子发布，失败删除临时文件，不覆盖用户文件；不支持硬链接的文件系统会明确失败。时长为采集时长，输出视频时长由帧数/帧率决定。

- 每个动作先查可用性：helper 没装、被停用、拉不起来或缺系统权限时在做事之前抛 `PERMISSION`，message 引导用户，并明说不要自己用 pip 装依赖；宿主不给 `attachImage` 时 `screenshot` 抛 `PLATFORM`。
- 按截图量的坐标必须带同一次截图的 `snapshotId`，全局坐标写 `coordinateSpace: 'global'` 且不带它，缺了或混用抛 `VALIDATION`；主屏、分辨率、缩放或原点变了，helper 拒绝旧 `snapshotId`，要重新截图。
- helper 只认按 `ComputerResourceLayout` 装好的平台包（`<资源根>/computer-use/computeruse-<平台>-<架构>/`）里的脚本加自包含 Python，缺一样就判资源未就绪，不回落系统 Python、不 `pip install`；开发时可用 `VELAROS_COMPUTER_PYTHON` 指定解释器，`VELAROS_COMPUTER_RESOURCE_ROOT` 一设就整组接管资源根。
- 宿主的安装器从 `bundledSourceRoot()` 取源（包里的 `computer/runtime/`，资产挪到别处时用 `VELAROS_COMPUTER_RUNTIME_SOURCE_ROOT` 指路）：把脚本复制进平台包、携带固定版本的 Python，并在构建时按本平台的 `requirements*.txt` 安装依赖，按 `ComputerHelperVersion` 判断要不要重装。
- 定位不缓存，每次现查磁盘，用户停用立刻生效；`resolve()` 尊重停用开关，`resolveIgnoringDisabled()` 只答物理上装没装。
- 运行时由宿主持有：helper 死了下一次调用重新拉起；`dispose()` 之后不能复用，直接调它报 `COMPUTER_SIDECAR_DISPOSED`，要用就重新造一份。helper 超时没回应抛 `TIMEOUT`，其余运行时失败的码见 `ComputerErrorCodes`。
- 原生请求复用 Core 的串行队列，同一时刻只下发一条。超时回收 helper，并拒绝该代次排队动作，不能在新进程中自动重放；超时动作的实际效果需要重新观察确认。旧进程的迟到事件不能清掉新进程。
- 宿主端口接受可选取消信号，模型操作始终转发本次调用的信号；排队期间取消的动作不再下发。已经进入系统调用的动作不能保证抢占，拖拽仍保证异常释放，录像有时长上限；运行中取消后应重新观察实际效果。
- 换成自己的 sidecar（`spawnProcess`）要说同一套 stdio 行协议：每行一个 JSON，请求 `{"id","command","payload"}`，应答 `{"id","ok","result"}` 或 `{"id","ok":false,"error":{"code","message"}}`，启动完成先发 `id: 0` 的握手；命令与截图绑定以 `computer/runtime/computer_helper_common.py` 为准。
