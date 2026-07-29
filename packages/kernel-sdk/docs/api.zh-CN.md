# `@velaros-ai/kernel-sdk` 中文接口文档

## 定位与非目标

本包是实现第三方 Kernel 模块所需的最小 SDK：capability token、模块清单、生命周期 context、服务/事件/权限/状态端口和 callable capability。它不包含 host 实现、传输或任何具体能力。

## 安装

```bash
npm install @velaros-ai/kernel-sdk
```

包为零运行时依赖 ESM，要求 Node.js 20 或更高版本。

## 公共入口

稳定入口为 `@velaros-ai/kernel-sdk`。所有公共符号由根入口导出，不支持引用 `dist` 内部路径。

## 核心类与接口

- `CapabilityToken<T>`、`createCapabilityToken`：类型安全的能力身份。
- `KernelModuleDefinition`、`KernelModuleManifest`、`defineKernelModule`：模块声明。
- `KernelModuleActivateContext`、`KernelModuleLifecycle`：激活和清理契约。
- `KernelServiceResolver`、`KernelServiceHandle<T>`：依赖服务访问。
- `KernelModulePermissionBroker`、`KernelStateStore`、`KernelModuleEventBus`：受限宿主端口。
- `createKernelCallableCapability`：把有限操作集合暴露为可校验调用服务。

## 生命周期/并发

模块只在 `activate` 中注册服务和订阅；返回的 `ready`、`suspend`、`dispose`、`health` hook 由 host 调度。实现必须让 `dispose` 幂等，并遵守 `context.signal`。不要缓存跨 generation 的 service handle。

## 依赖注入

依赖通过 manifest 的 `requires`/`optionalRequires` 声明，并从 `context.services` 获取。权限、状态和事件也只从 context 使用。模块不得访问 host 的全局容器。

## 错误模型

SDK 本身只定义边界；缺失依赖、失效 handle 和权限拒绝由 host 报错。Callable capability 的未知 operation 必须 fail closed，操作实现应验证 input 并返回明确错误。

## 最小第三方示例

```ts
import {
  createCapabilityToken,
  defineKernelModule,
} from '@velaros-ai/kernel-sdk'

export interface ClockService {
  now(): number
}

export const ClockCapability =
  createCapabilityToken<ClockService>('acme.clock', '1.0.0')

export default defineKernelModule({
  manifest: {
    id: 'acme.clock.system',
    version: '1.0.0',
    apiVersion: 1,
    provides: [ClockCapability],
    requires: [],
    optionalRequires: [],
    permissions: [],
    isolation: 'in-process',
  },
  activate(context) {
    context.registerService(ClockCapability, { now: () => Date.now() })
  },
})
```

## 扩展点

第三方可以定义任意 capability token 和模块；需要远程调用时使用 callable capability，并为每个 operation 声明最小权限。进程隔离由 host adapter 实现，不应写入 SDK。

## 兼容策略

Token 的 id 和 version 是公共身份，发布后不可随意更改。新增可选生命周期 hook 或 context 能力需要保持旧模块可运行；破坏 manifest/activate 契约时按 SemVer 提升主版本。
