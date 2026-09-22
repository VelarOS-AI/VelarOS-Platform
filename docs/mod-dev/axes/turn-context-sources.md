# 上下文来源与活动差量

持久证据源实现 ContextSourcePort 的 authorize/search/read/validate。活动事件使用 Context 的 createTurnContextSessionLedgers 和 createTurnContextAppendHub；消费者保存 generation 与 sequence，状态型来源用 replaceLatest。Runtime 负责把材料投影进最终模型请求。

接入说明见 [对应运行合同](../../architecture/platform-runtime.md)；源码结构遵循 [模块规范](../../architecture/module-ownership.md)。
