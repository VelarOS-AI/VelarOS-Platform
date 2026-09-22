# 生命周期注入

操作 prepare/run/observe/reconcile 和模块 activate/dispose 由各自生命周期调用。Runtime authorize、inputs、context.sources 等端口承担明确阶段的注入责任。Agent 的协议、上下文和执行端口由正式装配层负责。

接入说明见 [对应运行合同](../seams.md)；源码结构遵循 [模块规范](../../architecture/module-ownership.md)。
