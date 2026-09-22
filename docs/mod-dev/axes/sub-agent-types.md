# 子任务与模型工具

AgentSupervisor 负责持久子任务状态与收束，Velaros agents 模块提供 profiles/start/resume/reply/status/wait/cancel/send。主线可派发业务子任务；业务子任务获配搜索与整理等单一职责工具。角色的实际发现集合由 Runtime 构造。

接入说明见 [对应运行合同](../../architecture/platform-runtime.md)；源码结构遵循 [模块规范](../../architecture/module-ownership.md)。
