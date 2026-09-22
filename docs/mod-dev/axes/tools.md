# 模型操作

操作使用 Kernel 的 OperationModuleDefinition，每个方法集中声明 summary、input、output、effects 和 run。已有领域类由 createCapabilityModule 绑定生成 surface。Runtime 挂载后，模型通过模块 import 调用。

接入说明见 [对应运行合同](../getting-started.md)；源码结构遵循 [模块规范](../../architecture/module-ownership.md)。
