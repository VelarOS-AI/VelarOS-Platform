# Desktop 宿主指令接入差量

日期：2026-09-22。当前目标是让 Desktop 的身份与语言偏好进入 Platform 主会话的真实请求，并清理宿主闲置分支。

## Platform 合同

VelarosRuntimeOptions 在 contract/requires.ts 增加可选 instructions 文本。只接收宿主构造的可信产品指令；RuntimeBootstrap 在激活前校验类型，ComposedRuntime 只向主会话传递。RuntimeSession 将它与运行说明共同提供给循环、实际请求编译及整理候选预算检查；协议解码说明继续由原协议入口提供。

指令与实际请求一同归档，trace 可以核对当时内容。重建运行时后使用当前设置，已有请求档案保持原值。用户输入和文件正文继续通过输入材料进入上下文；宿主指令不能授予能力。专项模型工具沿自身职责装配，不继承主会话产品指令。

工具定义、模型操作与 schema 没有变化。

## Desktop 当前链路

PlatformHostInstructions 根据 locale 构造身份与回复语言说明；PlatformSessionRuntime 每次提交构造最新值，PlatformWorkspaceRuntime 通过公开 Runtime 参数传递。用户正文不进入宿主指令。原有模型驱动、工作区真实路径、Shell confinement 与确认策略保持原装配。

输入区、会话工厂、会话操作、Hook、CLI 和发送配置统一使用普通工作区链路；工作区能力由实际 workspace 与挂载模块决定。

## 清理与兼容差量

按用户明确要求删除纯聊天模式：移除输入区入口、状态更新方法、会话和 Hook 合同字段，以及发送时剥离能力/技能的分支。删除没有调用方的 pureChatSystemPrompt 与 pureChatDebugTurnSnapshot；提示词审计清单改为实际使用的 PlatformHostInstructions。

Desktop ChatSendRequest 不再继承旧 Agent 包中的 pureChatMode 字段。旧会话读取时显式丢弃这一历史字段，重新保存不会带回；其余执行模式和提示特性按现有规则恢复。

原“纯聊天关闭项目能力”验收随用户取消功能而撤销；工作区重开、文件读取和绑定变化拒绝的承诺由普通会话测试继续覆盖。增加旧字段迁移的往返测试。

## 验收

- Platform INV-43 新增 4 项：真实请求与追踪、重开应用新设置、宿主指令预算超限时不调用 provider、协议修复保留指令、非法配置拒绝激活。
- Desktop 实际 Platform 集成验证中英文切换只改变可信指令，用户正文不混入；Bridge 的交付顺序回归继续保留。
- 会话迁移与提示词审计 10 项通过，Hook 回归 8 项通过；CLI 参数解析回归通过。
- 21 个受影响类型分区通过；Platform 7 包拓扑构建与 IPC 构建通过。
- Desktop Runtime/Bridge 共 20 项通过，Electron Node 复测 20 项通过；生产构建和 Electron 入口产物核验通过。
- 两仓 module ownership 与 git diff --check 通过。
- Desktop 架构差量检查仍为 document-renderer README 的 6 项既有错误，本轮未修改该文件。
