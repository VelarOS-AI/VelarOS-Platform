# VelarOS 模块与 Mod 接入

Platform 提供两个有明确消费者的合同：Kernel 的可装载模块合同，以及 Act 的脚本能力合同。宿主负责资源、安装策略和具体装配；模型看到的能力由 Runtime 按当前会话投影。

| 接入目标 | 当前合同与入口 |
| --- | --- |
| 向模型脚本提供操作 | Kernel `OperationModuleDefinition`；传给 `createRuntime({modules})` |
| 复用已有领域操作 | Velaros `createCapabilityModule({surface,implementation,context,...})` |
| 安装、加载 Kernel 模块 | `KernelModuleDefinition`，`kernelModules` SDK，Kernel host/serve |
| 校验 Mod 清单 | Kernel `velarosModEnvelopes.parse` |
| 增加真实证据来源 | `createRuntime({context:{sources}})`，实现 `ContextSourcePort` |
| 配置搜索、子任务、长期记忆 | Runtime 的 `search`、`agents`、`memory`、`stores` 注入面 |
| 产品 UI | 产品或 VelarOS UI 所拥有的合同 |

`velaros.mod.json` 的 `module` 节由 Kernel 校验。`agent`、`ui` 是可选的不透明载荷，需要具体接入方提供解释器。清单解析成功只证明信封成立；实际能力由运行定义和宿主装配确定。

当前 Agent 包负责 ActLoop、ActRunService 和 AgentSupervisor。ScriptAct 的解析、模型工具、上下文策略与能力装配集中在 Velaros 的 Act 职责组。参见 [Platform 运行主链](../architecture/platform-runtime.md)。

## 开发入口

- [最小能力接入](getting-started.md)：操作定义、效果和 Runtime 装配。
- [按职责选择接入点](axes/README.md)：操作、上下文、任务、模板与产品 UI。
- [运行边界](seams.md)：调用、授权、上下文与生命周期。
- [权限](capabilities.md)：Kernel 权限与 Act 操作授权。
- [包格式](package-format-v1.md) / [分发](distribution.md)：清单与安全打包。
- [外部集成](integration.md) / [产品装配](product-agent-surfaces.md) / [工程约束](conventions.md)。

实现入口、类型和模板以 [模块规范](../architecture/module-ownership.md)、[Act 目录](../../packages/velaros/act/README.md) 及各包公开 exports 为准。
