# @velaros-ai/computer/tools

> `@velaros-ai/computer` 的一个导入切片(`packages/computer/src/tools`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

面向 agent 的桌面控制工具定义,共六个:

| 工具 | 档位 | 干什么 |
| --- | --- | --- |
| `computer_screenshot` | 只读 observe | 抓主显示器截图(逻辑分辨率,坐标 1:1) |
| `computer_screen_size` | 只读 observe | 读主显示器逻辑几何 |
| `computer_move` | 高风险 control | 移动光标(不点击) |
| `computer_click` | 高风险 control | 在坐标点击(左 / 右 / 中键、可连击) |
| `computer_type` | 高风险 control | 在当前焦点输入字面文本 |
| `computer_key` | 高风险 control | 按键或组合键(如 `cmd+a`、`enter`) |

**四个 control 档工具的每一次实际操作都要过宿主确认流程**;确认端口缺席时**不得默认放行**。
整个 `computer-control` 工具类别**默认关闭**,像浏览器模式一样需要显式 opt-in。

## 主要导出

- `computerTools` —— 按工具名索引的工具定义集合(无状态,进程内可复用)。
- `ComputerObserveCapability` / `ComputerControlCapability` —— 两档能力声明,**必须分开声明**。
- `ToolComputerApi` —— 已绑定到目标计算机的最小能力端口。
- `ComputerToolContext` —— 单次执行的 API、`AbortSignal` 与审批执行端口。

## 依赖注入

工具只认 `ToolComputerApi`。把 `@velaros-ai/computer/runtime` 的 `ComputerSidecarManager`
适配过去只是薄映射;接远程桌面、移动设备控制器或自研服务也走同一个接口。

```ts
import { computerTools, type ToolComputerApi } from '@velaros-ai/computer/tools'

const computer: ToolComputerApi = {
  ensureAvailable: () => remote.status(),
  screenSize: () => remote.screenSize(),
  screenshot: () => remote.screenshot(),
  mouseMove: (x, y) => remote.move(x, y),
  click: (x, y, options) => remote.click(x, y, options),
  typeText: (text) => remote.type(text),
  key: (keys) => remote.key(keys),
}

thirdPartyAgent.registerMany(Object.values(computerTools), () => ({
  computer,
  abortSignal: controller.signal,
  execution: confirmationPort, // 缺席即不得放行 control 档
}))
```

## 生命周期与并发

工具定义无状态。每次调用由宿主创建 context;并发、排队与资源互斥由注入的 `ToolComputerApi` 负责。

## 错误模型

输入由 Zod 在执行边界校验。环境不可用以 `ComputerAvailability` **返回**(不抛);
运行失败由注入的 API 抛出。**审批拒绝与取消要保持独立错误码**,不要压成普通执行失败
——否则重试逻辑会把用户的「不同意」当成偶发故障再试一次。

## 边界

不依赖 `@velaros-ai/agent`、不碰产品 IPC、**不直接访问操作系统**。
本切片只定义工具与其 context 契约;sidecar 所有权、确认流程与 UI 都由宿主组合。

## 扩展点

新增动作要**先**扩展 `ToolComputerApi` 与能力声明,**再**加工具。
应用专属的快捷键或 UI 操作留在应用侧工具集合,不进默认集合。
