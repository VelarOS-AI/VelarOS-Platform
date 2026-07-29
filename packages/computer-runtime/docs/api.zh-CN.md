# @velaros-ai/computer-runtime 中文接口文档

## 定位与非目标

本包管理操作系统级 Computer Use sidecar：解析平台 helper、懒启动子进程、完成 ready 握手、通过 JSON Lines 关联请求与响应，并暴露截图和输入控制 API。

本包不包含 Agent 工具注册、UI、审批流程或产品 IPC。第三方也可以完全替换 helper 解析器和进程创建器。

## 安装

```bash
npm install @velaros-ai/computer-runtime
```

要求 Node.js 20 及以上。默认 helper 使用随包资源中的 Python runtime；自定义 sidecar 不要求 Python。

## 公共入口

```ts
import {
  ComputerSidecarManager,
  ComputerHelperResolver,
  ComputerResourceRuntimeRegistry,
  createComputerKernelModule,
  encodeComputerRequest,
  decodeComputerResponse,
  type ComputerRuntimePort,
} from '@velaros-ai/computer-runtime'
```

## 核心类与接口

- `ComputerSidecarManager`：sidecar 的长生命周期对象和 `ComputerRuntimePort` 默认实现。
- `ComputerHelperResolver`：解析当前平台 helper 与解释器。
- `ComputerResourceRuntimeRegistry`：宿主拥有的资源根目录和停用状态注册表。
- `ComputerSidecarProcess` / `ComputerSidecarSpawner`：最小可替换子进程端口。
- `ComputerRuntimePort`：供工具层或 Kernel 模块消费的稳定能力协议。
- `createComputerKernelModule()`：可选的 Kernel SDK 适配器。

## 生命周期/并发

一个应用组合根通常创建一个 `ComputerSidecarManager`。首次动作时懒启动；并发请求使用单调请求 ID 关联响应。每个请求有独立超时，sidecar 退出会拒绝所有未完成请求。应用退出必须调用 `dispose()`。

资源注册表应由宿主创建并注入。导出的默认单例仅用于 0.x 兼容，不适合作为多租户状态容器。

## 依赖注入

`ComputerSidecarManagerOptions` 可注入：

- `resolveHelper`：任意 helper 定位逻辑；
- `spawnProcess`：容器、远程进程或测试替身；
- `requestTimeoutMs`：请求期限；
- `onLog`：宿主日志接收器。

因此第三方无需采用 VelarOS 的资源目录布局。

## 错误模型

`ensureAvailable()` 将常见环境问题转换为结构化 `ComputerAvailability`，不抛出可预期的“未安装/缺权限”错误。动作方法在协议错误、超时、sidecar 崩溃或已释放时抛出 `Error`。调用方应先检查 availability，再执行动作。

## 最小第三方示例

```ts
import { ComputerSidecarManager } from '@velaros-ai/computer-runtime'

const manager = new ComputerSidecarManager({
  resolveHelper: () => ({
    pythonCommand: '/opt/acme-runtime/bin/python',
    helperScript: '/opt/acme-runtime/helper.py',
    runtimeDir: '/opt/acme-runtime',
    packageRoot: '/opt/acme-runtime',
    version: '1.0.0',
    bundledVenv: true,
  }),
  onLog: (message) => applicationLogger.debug(message),
})

try {
  const availability = await manager.ensureAvailable()
  if (!availability.available) throw new Error(availability.detail ?? availability.reason)
  const screenshot = await manager.screenshot()
  await consumeScreenshot(screenshot)
} finally {
  manager.dispose()
}
```

## 扩展点

实现 `ComputerRuntimePort` 可接入原生扩展、远程桌面服务或 WebDriver；实现 `ComputerSidecarSpawner` 可替换进程载体。Kernel 模块接受已有 runtime，默认不接管其生命周期。

## 兼容策略

现有协议函数、默认单例和 `resolveComputerHelper()` 保持兼容。新接入应优先显式创建资源注册表和 resolver。协议字段只能以向后兼容方式增加；破坏性 wire 变更需要新的协议版本。
