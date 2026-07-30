# @velaros-ai/computer

> **位置**:VelarOS-Platform 单版本火车 · `capabilities` 域 · 目录 `packages/computer`。
> 它是**桌面控制能力**(Computer Use)的唯一家:让 agent 看屏幕、动鼠标、敲键盘。
> 域归属由仓根 `package.json` 的 `velaros.domainPackages` 声明,不看目录深浅。

## 这个包解决什么问题

模型要操作**本机图形界面**——截图看现在长什么样,然后移动光标、点击、输入文字、按快捷键。
这件事必须落到操作系统 API 上,而 Node 侧没有跨平台的现成通道,所以本包的做法是
**跑一个 Python sidecar 子进程**,用 JSON Lines 协议跟它对话。

本包管两件事:**sidecar 的进程生命周期与协议**,以及**给 agent 用的那六个工具**。
它**不做权限决策**——高风险动作的确认流程在宿主。

## 对外分区

**本包刻意没有根导出**。两个切片各自 `exports`,只装配 sidecar 的宿主不该被迫吃进
工具集合的 zod schema 面。

| 子路径 | 源码 | 一句话职责 |
| --- | --- | --- |
| `@velaros-ai/computer/runtime` | `src/runtime` | 可注入的 OS 级 sidecar 管理器 + JSON Lines 协议 |
| `@velaros-ai/computer/tools` | `src/tools` | 宿主注入式的观察 / 输入控制 agent 工具 |

切片细节见 [`docs/runtime/README.md`](./docs/runtime/README.md) 与
[`docs/tools/README.md`](./docs/tools/README.md)。

**注意目录同名陷阱**:包根下的 `runtime/` 是**随包发布的 Python helper 资产目录**
(`mac_helper.py` / `win_helper.py` / `linux_helper.py` + 各平台 `requirements*.txt`),
跟 `src/runtime` 那个 TS 切片是两回事。helper 从宿主提供的资源根解析,不写死路径。

## 核心概念

**可用性先于动作**。`ensureAvailable()` 把「没装 Python / 缺依赖 / 没有显示器 / 没给系统权限」
这类环境问题**转换成结构化的 `ComputerAvailability` 返回值,而不是抛异常**——它们是可预期状态,
不是错误。调用方应当先查 availability 再执行动作;真正的协议错误、超时、sidecar 崩溃才抛。

**两档能力,分开声明**。`ComputerObserveCapability`(截图 / 屏幕尺寸)是只读档;
`ComputerControlCapability`(移动 / 点击 / 输入 / 按键)是高风险控制档,**每次实际操作都要过宿主
确认流程**。整个 `computer-control` 工具类别**默认关闭**,像浏览器模式一样需要显式 opt-in。
确认端口缺席时**不得默认放行**。

**坐标 1:1**。截图始终按逻辑分辨率抓取,这样模型从图上读到的坐标可以直接拿去点击,
中间不需要缩放换算。

## 典型用法

宿主侧:建一个长生命周期的 sidecar 管理器,自己决定 helper 从哪来。

```ts
import { ComputerSidecarManager } from '@velaros-ai/computer/runtime'

const manager = new ComputerSidecarManager({
  resolveHelper: () => ({
    pythonCommand: '/opt/acme-runtime/bin/python',
    helperScript: '/opt/acme-runtime/helper.py',
    runtimeDir: '/opt/acme-runtime',
    packageRoot: '/opt/acme-runtime',
    version: '1.0.0',
    bundledVenv: true,
  }),
  onLog: (message) => logger.debug(message),
})

try {
  const availability = await manager.ensureAvailable()
  if (!availability.available) throw new Error(availability.detail ?? availability.reason)
  const shot = await manager.screenshot()
  await consume(shot)
} finally {
  manager.dispose() // 进程退出必须释放
}
```

工具侧:把管理器适配成 `ToolComputerApi` 注入即可(`leftClick()` → `click()` 之类的薄映射),
接远程桌面或移动设备控制器也走同一个接口。

```ts
import { computerTools, type ToolComputerApi } from '@velaros-ai/computer/tools'

const computer: ToolComputerApi = {
  ensureAvailable: () => manager.ensureAvailable(),
  screenSize: () => manager.screenSize(),
  screenshot: () => manager.screenshot(),
  mouseMove: (x, y) => manager.mouseMove(x, y),
  click: (x, y, options) => manager.click(x, y, options),
  typeText: (text) => manager.typeText(text),
  key: (keys) => manager.key(keys),
}
// computerTools:computer_screenshot / computer_screen_size /
//                computer_move / computer_click / computer_type / computer_key
```

## 边界:本包不负责什么

- **不做权限决策、不实现审批 UI**——确认流程住宿主,本包只要求 context 里有确认端口。
- **不拥有产品 IPC、不依赖 `@velaros-ai/agent`**。工具只定义自己和自己的 context 契约;
  谁来执行、怎么排队、界面长什么样,由宿主组合。
- **tools 切片不直接访问操作系统**,只经 `ToolComputerApi`;runtime 切片**不注册 agent 工具**。
- 不打包 Python 解释器本身;`resolveHelper` 与 `spawnProcess` 都可被宿主整个替换,
  自定义 sidecar 甚至不需要 Python。

## 与相邻包的关系

- 上游只有 `@velaros-ai/core`(错误模型、工具契约原语)与 `zod`。
- 与 `@velaros-ai/agent` 是**被注入关系**:本包不 import 它,宿主在装配根把 `computerTools`
  注册进 agent 运行时。
- `src/runtime/kernel-module.ts` 提供可选的 Kernel 模块适配器(`createComputerKernelModule`),
  默认**不接管**调用方注入的 runtime 生命周期。
- 姐妹能力包:`@velaros-ai/browser`(浏览器自动化)、`@velaros-ai/workspace`(本地代码工作区)。

## 兼容策略

切片子路径即兼容面。现有工具名、`ToolComputerApi` 必选成员、协议函数保持兼容;
新增高风险能力**不会自动进默认启用面**;协议字段只能向后兼容地增加,破坏性 wire 变更要升协议版本。
版本随平台单版本火车推进。
