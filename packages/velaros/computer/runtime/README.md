# velaros:computer 的 helper 资产

这个目录随 `@velaros-ai/velaros` 发布（包清单 `files` 里的 `computer/runtime`），是桌面控制真正干活的那一侧：
三个平台脚本（`mac_helper.py`、`win_helper.py`、`linux_helper.py`）加一份共享模块（`computer_helper_common.py`），
以及各平台的第三方库清单（`requirements*.txt`）。单元怎么用它们见 [模块卡片](../MODULE.md)。

## 怎么被拉起

TypeScript 那一侧的运行时（`createComputerRuntime`）第一次真正用到桌面能力时，按 helper 定位器的回答拉起当前平台的脚本。
定位器只认按需安装的平台包（`<资源根>/computer-use/computeruse-<平台>-<架构>/`）：里面是从这个目录装过去的脚本，加上自带的 venv。
脚本或 venv 缺一样就判「未安装」，不回落系统 Python、不 `pip install`。开发者可以用 `VELAROS_COMPUTER_PYTHON` 显式指定解释器。

宿主的安装器从这个目录取源：`createComputerHelperLocator().bundledSourceRoot()` 给出它的位置，
装到别处时用 `VELAROS_COMPUTER_RUNTIME_SOURCE_ROOT` 指路。改了这里的脚本就升 `ComputerHelperVersion`，安装器按它判断要不要重装。

## 协议

stdin / stdout 上按行分帧的 JSON：

```
request  (stdin) : {"id": <number>, "command": <string>, "payload": {...}}\n
response (stdout): {"id": <number>, "ok": true,  "result": <any>}\n
                   {"id": <number>, "ok": false, "error": {"code","message"}}\n
```

`id: 0` 保留给 helper 启动完成时主动发来的握手。请求 id 从 1 单调递增，并发请求靠 id 关联，不必串行。
命令只有七个：`check`、`screen_size`、`screenshot`、`mouse_move`、`left_click`、`type`、`key`，三个平台一致；
协议与截图绑定都在 `computer_helper_common.py` 里，平台脚本只实现各自的 `dispatch`，线格式不会在平台之间漂移。

## 截图绑定

`screenshot` 为这次截到的主屏登记一条绑定，交回不透明的 `snapshotId`。之后按截图坐标移动、点击必须带上它：
helper 在真正动手之前核对主屏的设备身份与几何（显示器、宽高、缩放、原点）没变，再把截图坐标换算成全局坐标。
变了就拒绝（`screen_snapshot_stale`）并作废这条绑定——它以后也不会再变得可信。全局坐标不许带 `snapshotId`。

macOS 用系统的 display id；Windows、Linux 首选 screeninfo，组合设备名与枚举位置，能区分同名、同尺寸的屏幕。
只有退回缺设备身份的 mss 时，绑定只能校验几何变化，分不出几何完全相同的两块主屏互换。

## 错误

可预期的失败用 `ComputerHelperError(code, message)` 报出来，`code` 是 `ComputerHelperErrorCodes` 那张表里的码
（`screen_snapshot_required`、`screen_snapshot_stale`、`screen_snapshot_unexpected`、`screen_coordinate_out_of_bounds`、
`screen_coordinate_space_invalid`、`screen_state_invalid`）。TypeScript 一侧按码翻成给模型看的中文，所以这里的英文措辞可以随便改，改码才影响判定。
