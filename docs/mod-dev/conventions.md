# 接入工程约束

所有治理模块统一使用 contract/types/impl/utils。contract/provides.ts 登记产品面，requires.ts 声明注入面，constants.ts 集中合同常量；数据和内部工作类型进入 types；类 API 写在类上方；纯函数与可调参数进入 utils。文件按职责组织，目录只在实际内容需要时分组。

模型操作在登记的定义位置保持 schema、效果、处理器、发现说明和模板一致。领域 surface 经生成器输出；Act 系统、搜索和子任务操作由各自的 impl/*Module.ts 定义。公开入口只转发合同控制的 API。

状态按拥有者管理：Context 保存原文、检查点和调用记录；StoreStorage 保存共享对象和消息；领域端口管理真实外界资源；宿主负责连接、身份和范围。日志或派生摘要不能覆盖原始事实。

修改公开合同、模型操作或验收承诺时提交逐项差量报告。使用 [模块规范](../architecture/module-ownership.md)、[工程规范](../engineering/code-standard.md)、[模块说明规范](../architecture/module-readme.md) 和模块根目录的 README.md，运行相应类型、行为、生成与所有权检查。
