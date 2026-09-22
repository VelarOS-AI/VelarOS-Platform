# 产品如何装配 Act

产品提供工作区、数据目录或 ContextStorage、模型驱动、授权策略与领域端口，统一通过 `createRuntime` 打开会话。submit 接纳输入；steer 递交运行中补充；answer 回答绑定的交互；inspect/events 读取持久状态；cancel/close 收束生命周期。

任务、工作材料、observe 输出、近期记录、运行信息由 Runtime 的五分区上下文机制组装。用户原文、脚本版本和结果保存在 ContextStorage；长期记忆由宿主固定 MemoryScopePort；共享结构化状态与消息由 StoreStorage 保存。

主线按需使用搜索、整理与业务子任务。宿主通过 Runtime 的 search、agents、context.maintenance 和 modelTools 配置实际角色能力及资源上限。模型看到当前角色可发现的模块，子任务能力由派发 profile 与授权范围固定。

产品负责把 Act 事件投影为自己的界面，并保留输入接纳、实际请求绑定、尚未消费输入和真实终态的区别。公开事件类型见 `@velaros-ai/agent/contracts`；当前完整链路见 [Platform runtime](../architecture/platform-runtime.md)。
