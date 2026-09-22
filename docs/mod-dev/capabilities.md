# 能力与权限

Kernel 模块通过 `kernelModules.token/requirement/define/callable` 声明和提供服务。KernelModuleDefinition 的 manifest 声明模块依赖与权限，由 Kernel host 的权限端口处理调用。

Act 脚本能力使用 OperationModuleDefinition：binding 固定 moduleId、instanceId、generation、schemaRevision；操作描述定义 input/output schema 与 effects。Runtime 的 authorize 在派发前接收 PreparedInvocation 和 OperationDescriptor；具体资源范围由宿主注入的领域端口执行。

会话能力投影同时决定发现、模板、类型声明和执行绑定。主线可以配置业务子任务；业务子任务可以获配搜索与整理；单一职责模型工具只拿完成自身职责所需的模块。共享 store 的读写范围由可信会话配置和派发授权固定。

observe 每轮重新执行。`effects: 'none'` 的处理器必须遵守只读约定；存在写效果的命令只有通过明确的观察适配器才能进入 observe。进程限制以实际隔离证据为准。未决外界效果先核对原调用，不能凭取消或模型猜测认定成功。

权限、执行收据与恢复的真实入口见 [运行保障](../architecture/runtime-assurance.md)、[系统空间](../architecture/act-system-space.md) 和 Kernel 的 contract/requires.ts。
