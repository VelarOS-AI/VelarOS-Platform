# Act 高级搜索及真实证据

## 这是什么

高级搜索及真实证据的代码按职责集中维护。模型模块包括 `velaros:search`, `velaros:evidence`。

## 提供什么

入口 `./act/search`。装配实例 `searchModule`, `evidenceModule`。
接口：`EvidenceHost`, `EvidenceService`, `EvidenceActivation`, `SearchHost`, `SearchService`, `VelarosSearchOptions`, `SearchModuleApi`, `EvidenceModuleApi`。
操作每次调用的宿主上下文：`SearchOperationContext`, `EvidenceOperationContext`。

操作清单与入口模式见 [Act 清单](../README.md)，默认模板见 [template.js](template.js)，其他模块使用同目录的 `<模块>-template.js`。

## 骨干链路

`impl/*Operations.ts` 的操作接口生成模型面（`contract/surface.ts`）→ `impl/*Module.ts` 用 `capabilityModules` 接到当前会话端口 → Kernel 注册、结构校验、模式和权限检查 → 搜索编排与证据访问核对档位、来源、预算与取值上限（`SearchLimits`）→ 持久回执。

## 依赖什么

通过 contract/requires.ts 注入能力，复用 Kernel、Context 和 Script 的执行链。生成模型面的接口在本组，装配器与会话装配在 runtime。

## 状态归谁

版本、原文、调用状态和租约由现有会话存储持有。搜索活动维护自己的有限预算与恢复状态。runtime.modelTool 持续提供已经真实读取且版本校验通过的有界证据目录；结果租约只控制执行输出，目录独立保留证据身份、版本、短摘录及原文引用。目录是来源数据，省略数量和摘录截断明确反馈。

## 生命周期

随 Runtime 装配；调用绑定 sessionId 与取消信号。会话结束时由共同生命周期释放资源。

## 失败语义

模式或权限拒绝进入真实操作回执；端口错误按已有恢复与核对机制处理。

## 不变量

共 2 条，未验证 0 条。见 spec/invariants.md。

## 非目标

能力范围由实际宿主端口、模块配置与当前授权共同决定。

## 结构

```text
search/
  contract/ 提供面、注入面、常量；surface.ts 是生成的模型面
  impl/ 操作接口与实现、按模块命名的装配、搜索编排
  utils/ 取值上限的核对与可调参数（tuning.ts）
  spec/ 验收测试与不变量
  index.ts
  template.js
  <模块>-template.js
  types.ts
```
