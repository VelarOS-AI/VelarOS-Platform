# Act 子任务和用户交互

## 这是什么

子任务和用户交互的代码按职责集中维护。模型模块包括 `velaros:agents`, `velaros:interaction`。

## 提供什么

入口 `./act/agents`。装配实例 `agentsModule`, `interactionModule`。
接口：`AgentsHost`, `AgentsSession`, `InteractionHost`, `InteractionSession`, `AgentsModuleApi`, `InteractionModuleApi`。

操作清单与入口模式见 [Act 清单](../README.md)，默认模板见 [template.js](template.js)，其他模块使用同目录的 `<模块>-template.js`。

## 骨干链路

模块装配实例 → Kernel 注册 → schema、模式和权限检查 → 当前会话端口 → 持久回执。

## 依赖什么

通过 contract/requires.ts 注入能力，复用 Kernel、Context 和 Script 的执行链。公共 schema 构造与会话装配在 runtime。

## 状态归谁

版本、原文、调用状态和租约由现有会话存储持有。Supervisor 保存子任务请求和结果，活动权与累计预算由原运行服务维护。

## 生命周期

随 Runtime 装配；调用绑定 sessionId 与取消信号。子任务请求先持久化再唤醒父任务，reply 回答当前请求；resume 只在子任务收束后更新环境。会话结束时由共同生命周期释放资源。

## 失败语义

模式或权限拒绝进入真实操作回执；端口错误按已有恢复与核对机制处理。

## 不变量

共 1 条，未验证 0 条。见 spec/invariants.md。

## 非目标

能力范围由实际宿主端口、模块配置与当前授权共同决定。

## 结构

```text
agents/
  contract/ 提供面、注入面、常量
  impl/ 按模块命名的实现
  spec/ 验收测试与不变量
  index.ts
  template.js
  <模块>-template.js
```
