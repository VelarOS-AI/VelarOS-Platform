# @velaros-ai/computer/runtime

> `@velaros-ai/computer` 的一个导入切片(`packages/computer/src/runtime`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

OS 级桌面控制的 **sidecar 宿主**:拉起 Python helper 子进程,用行分隔 JSON 协议跟它对话,
把请求与响应按 id 关联,管理进程生命周期(懒启动 / 释放),按平台挑 helper
(macOS / Windows / Linux),并在 Python、依赖、显示器或系统权限缺席时**优雅地报告不可用**。

Python helper 与各自的 `requirements*.txt` 随包发布在包根 `runtime/` 下,按 sidecar 打包惯例
作为应用资源分发。

## 协议

```
request  (stdin) : {"id": <number>, "command": <string>, "payload": {...}}\n
response (stdout): {"id": <number>, "ok": true,  "result": <any>}\n
                   {"id": <number>, "ok": false, "error": {"code","message"}}\n
```

`id: 0` **保留**给 helper 启动时发出的 ready 握手。请求 id 单调递增,因此并发请求可以靠 id 关联,
不需要串行化。

## 主要导出

- `ComputerSidecarManager` —— sidecar 的长生命周期对象,也是 `ComputerRuntimePort` 的默认实现。
- `ComputerHelperResolver` / `resolveComputerHelper` —— 解析当前平台的 helper 与解释器。
- `ComputerResourceRuntimeRegistry` —— 宿主拥有的资源根目录与停用状态注册表。
- `ComputerSidecarProcess` / `ComputerSidecarSpawner` —— 最小可替换的子进程端口。
- `encodeComputerRequest` / `decodeComputerResponse` / `drainResponseLines` —— 协议编解码。
- `createComputerKernelModule()` —— 可选的 Kernel 模块适配器。
- `Computer*` 结果与可用性类型。

## 生命周期与并发

一个装配根通常只建**一个** `ComputerSidecarManager`。首次动作时才懒启动子进程;
每个请求有独立超时;sidecar 退出会**拒绝所有未完成请求**;应用退出必须 `dispose()`。

截图绑定使用主屏设备身份与几何。macOS 使用系统 display id；Windows/Linux 的首选 screeninfo
路径组合系统设备名和枚举位置，能区分同名、同尺寸屏幕。只有退回缺少设备身份的 mss 路径时，
绑定才能校验几何变化，无法区分几何完全相同的主屏互换。

资源注册表应由宿主创建并注入。导出的默认单例只为 0.x 兼容保留,**不适合当多租户状态容器**。

`createComputerKernelModule()` 默认**不接管**调用方注入的 runtime——只有显式设置
`disposeInjectedRuntime: true` 才转移释放责任。

## 依赖注入

`ComputerSidecarManagerOptions` 可注入:

- `resolveHelper` —— 任意 helper 定位逻辑(所以第三方不必采用 VelarOS 的资源目录布局);
- `spawnProcess` —— 容器、远程进程或测试替身;
- `requestTimeoutMs` —— 请求期限;
- `onLog` —— 宿主日志接收器。

## 错误模型

**可预期的环境问题不抛异常**:`ensureAvailable()` 把「没装 / 缺权限 / 没显示器」转换成结构化的
`ComputerAvailability`。动作方法只在协议错误、超时、sidecar 崩溃或已释放时抛 `Error`。
先查 availability,再执行动作。

## 边界

不依赖 `@velaros-ai/agent`、不依赖 tools 切片、不碰产品 IPC。本切片只管 helper 进程与 wire 协议;
工具注册、审批流程与 UI 都在别处。

## 用法

```ts
import { ComputerSidecarManager } from '@velaros-ai/computer/runtime'

const manager = new ComputerSidecarManager()
try {
  const availability = await manager.ensureAvailable()
  if (availability.available) {
    const shot = await manager.screenshot()
    await manager.leftClick(120, 80, {
      coordinateSpace: 'primary-display',
      snapshotId: shot.snapshotId,
    })
  }
} finally {
  manager.dispose()
}
```

## 扩展点

实现 `ComputerRuntimePort` 可接入原生扩展、远程桌面服务或 WebDriver;
实现 `ComputerSidecarSpawner` 可替换进程载体。自定义 runtime 处理 `primary-display` 点击时必须在
真实输入前验证 `snapshotId`，并在主屏布局变化或绑定未知时 fail closed；省略 coordinateSpace 的
既有调用仍是全局坐标。
