# Computer Use 扩展差量

原先只有截图、移动、点击、文字与快捷键，不能表达滚轮、拖拽、按住状态，也不能直接发现窗口、观察或操作控件、生成录像。新增 15 项操作，保留已有 5 项，仍使用同一个 `velaros:computer`、Kernel 效果授权与宿主端口。

## 合同变化与理由

- `ComputerOperationsApi` 与 `ComputerSpacePort`/`ComputerRuntimeApi` 同步扩展：基础输入、窗口观察、语义控件、有界录像都有正式模型声明与 stdio 命令。第三方宿主实现端口需要实现这些新方法；不提供假成功兼容壳。
- `ComputerPoint`、坐标选项与回执扩展 `window` 空间，`ComputerSnapshot` 增加可选 `windowId`。主屏与全局坐标的原有写法保留；窗口图不能按主屏图解释。
- helper 版本从 0.3.0 升为 0.4.0；新 Python 文件和固定依赖需由宿主重新打包。pywinauto、PyAutoGUI、PyObjC、python-xlib 与 PyAV 提供底层能力；上游许可证与分发元数据保留。
- 新参数限制登记于 `ComputerInputLimits`，包括滚动、拖拽、输入租约、控件树、录像预算。模型文档说明对应范围，入参失败发生在拉起 helper 之前。
- 原生请求复用 Core 串行队列；helper 重置后拒绝旧代次排队动作，迟到进程事件不能破坏替代进程。宿主端口接收可选取消信号，模型操作始终转发调用信号，已取消但尚未下发的动作不会执行。
- `INV-6` 原“五个操作”改为正式 20 项；原承诺限制了用户明确需要的输入和观察能力。`INV-9`、`INV-11` 去除五项数量约束，保持单一实现、真实端口与生成声明一致的边界。原有坐标绑定、授权、定位不联网和截图交图承诺继续成立。
- 模板补充能力发现、窗口观察、语义激活、滚动、拖拽、按住配对和录像；所有示例仍由实际声明检查。

## 运行约束

Windows 与 macOS 提供原生控件树；Linux 当前只交付 X11 窗口能力，没有随包 AT-SPI 后端，Wayland 不能作为完整输入/捕获后端。Windows/X11 的窗口截图会受遮挡影响，能力报告明确说明。Linux 字面 Unicode 输入仍受 PyAutoGUI 后端限制。

输入按住有租约与 EOF 清理；拖拽异常释放。系统强杀 helper 无法保证松开操作。控件树查询有限深度/节点/时间预算，失败与不完整性可见。录像限制 5 秒、10fps、16MP，无音频，只写新的绝对路径 MP4；非硬链接文件系统发布失败不会覆盖已有文件。

## 验证入口

- 模块结构：`bun run check:module-ownership`。
- 生成面：`bun run generate:script -- --module computer`、`bun run check:script`。
- 扩展行为：`node --test tests/packages/velaros/computer/extended-runtime.test.mjs`；设置 `VELAROS_COMPUTER_TEST_PYTHON` 为 Desktop 打包解释器时包含真实视频编码与解码。
- 既有能力验收：`packages/velaros/computer/spec/acceptance.test.ts` 与原 helper/sidecar 回归。

新行为回归登记在包的 `test`/`test:built`，位置在 `tests/packages/velaros/computer/`。具体运行结果在本次交付中报告，不以文档替代执行证据。

本次在 Windows 验证了扩展行为回归（包括真实 PyAV 编解码）、原生 helper 能力探测与窗口枚举、既有坐标和 sidecar 回归。macOS/Linux 新增原生适配尚未在对应设备验收；平台能力报告和已知限制不能替代这些实机验证。
