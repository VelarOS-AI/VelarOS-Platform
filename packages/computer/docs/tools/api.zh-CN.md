# @velaros-ai/computer/tools 中文接口文档

## 定位与非目标

本包提供 Computer Use 的 Agent 工具定义：屏幕观察、鼠标移动与点击、文本输入和键盘组合。工具只依赖 `ToolComputerApi`，可以连接默认 sidecar，也可以连接任何第三方计算机控制服务。

本包不启动 sidecar，不保存状态，不实现审批 UI，也不直接访问操作系统。

## 安装

```bash
npm install @velaros-ai/computer/tools @velaros-ai/computer/runtime @velaros-ai/core zod
```

要求 Node.js 20 及以上。

## 公共入口

```ts
import {
  computerTools,
  ComputerObserveCapability,
  ComputerControlCapability,
  type ComputerToolContext,
  type ToolComputerApi,
} from '@velaros-ai/computer/tools'
```

## 核心类与接口

- `computerTools`：按工具名索引的工具定义集合。
- `ToolComputerApi`：已经绑定到目标计算机的最小能力端口。
- `ComputerToolContext`：单次工具执行的 API、AbortSignal 和审批执行端口。
- `ComputerObserveCapability`：截图和屏幕尺寸的只读能力声明。
- `ComputerControlCapability`：键鼠控制的高风险能力声明。

## 生命周期/并发

工具定义无状态。每次调用由宿主创建 context；并发、排队和资源互斥由注入的 `ToolComputerApi` 实现。高风险输入动作必须经过 context 中的确认端口，不能因确认端口缺失而默认放行。

## 依赖注入

将 `ComputerSidecarManager` 适配为 `ToolComputerApi` 时只需把 `leftClick()` 映射为 `click()`。第三方远程桌面或移动设备控制器也可直接实现该接口。

## 错误模型

工具输入由 Zod 在执行边界校验。环境不可用以 `ComputerAvailability` 返回；运行失败由注入 API 抛出。审批拒绝与取消应保持独立错误代码，避免转换成普通执行失败。

## 最小第三方示例

```ts
import { computerTools, type ToolComputerApi } from '@velaros-ai/computer/tools'

const computer: ToolComputerApi = {
  ensureAvailable: () => remoteComputer.status(),
  screenSize: () => remoteComputer.screenSize(),
  screenshot: () => remoteComputer.screenshot(),
  mouseMove: (x, y) => remoteComputer.move(x, y),
  click: (x, y, options) => remoteComputer.click(x, y, options),
  typeText: (text) => remoteComputer.type(text),
  key: (keys) => remoteComputer.key(keys),
}

thirdPartyAgent.registerMany(
  Object.values(computerTools),
  () => ({
    computer,
    abortSignal: new AbortController().signal,
    execution: confirmationPort,
  }),
)
```

## 扩展点

新增动作应先扩展 `ToolComputerApi` 和能力声明，再增加工具；应用专属快捷键或 UI 操作应留在应用侧工具集合。观察与控制权限必须分开声明。

## 兼容策略

现有工具名和 `ToolComputerApi` 必选成员保持兼容。新增高风险能力不会自动加入默认启用面；删除或更改输入语义需要新的主版本。
