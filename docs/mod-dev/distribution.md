# 分发与宿主安装

使用 [包格式](package-format-v1.md) 的 pack/inspect/validate 命令生成和校验 `.velarmod`。Kernel 的 serve 模块负责本地装载与模块存储，公共入口和配置以 `@velaros-ai/kernel/serve` 为准。

宿主拥有安装目录、来源验证、升级策略、权限确认、激活与卸载 UI。模块的 provides/requires 与 manifest 描述可被装载的能力；作者提供的名称、发布者和信任声明须与宿主验证结果区分。

KernelModuleDefinition.activate 返回生命周期对象时，Kernel 按模块生命周期处理资源。Act 的 OperationModuleDefinition 通过其 activate/dispose 管理挂载资源。宿主衔接这两种生命周期时，需要保证停用后不再派发新操作，已有操作按信号和回执收束。

发布前检查入口寻址、模块依赖、最小权限、取消、重新激活、运行记录恢复及打包内容。Platform npm 包使用仓库统一的 [安全打包与发布流程](../engineering/local-package-release.md)。
