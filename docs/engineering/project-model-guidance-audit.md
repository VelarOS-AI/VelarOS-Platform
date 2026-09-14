# Project 模型指导同步检查

`packages/project/test/project-guidance-drift.test.ts` 属于 Project 默认测试和发布检查链。它校验当前注册的 8 个工具的真实示例、完整 JSON Schema（包含参数描述），并与人工审核记录 `project-model-guidance-review.json` 比较。

检查通过实际 `PromptRegistry` 组装 192 个组合：三种操作系统、两种语言、启动/执行阶段、计划进度、目标模式、视觉能力和技能可读状态。每个注册的内置段必须至少实际渲染一次。Agent 的 `promptRuntimeAvailability.test.ts` 另从 `RunContext → PromptState` 验证当前指导进入最终系统提示词。宿主身份、角色权限和宿主贡献段由 Workbench/Desktop 各自的真实 provider 请求测试覆盖。

审核记录保存入口到源文件的清单及内容指纹，覆盖工具发现/换入/召回/计划说明、参数复用、失败回执、当前文件与最终引用、用户文档。工具 schema、描述、示例或这些指导来源改变后，发布测试要求重新审核。新增必填参数、操作改名、仅改变 schema 描述，以及示例已更新但审核记录未更新，都有故障注入测试证明检查会拒绝。

静态 Project 工具说明把能力发现路由交给当前运行时指导，不直接要求调用依角色决定是否注入的控制工具。只读角色缺少发现入口时，搜索结果仍明确保持候选证据语义；故障注入测试会拒绝重新加入无条件发现要求。

候选语法诊断与一次性恢复投影也纳入来源指纹。`project-validation-reuse.test.ts` 通过真实 Project → Agent Executor → Provider 编译链验证：写入前校验失败保留 `not-applied` 与参数复用入口，大段正文仅修改原文范围即可恢复；候选行号不授予编辑引用、不替换当前文件视图，下一次决策后只保留短回执，原始历史保持完整。Agent 另覆盖直接及 ContextRef 包装的四种工具结果载体。

审核步骤：

1. 检查变更后的参数意图、恢复路径、全部示例与实际组装输出，并确认宿主测试仍通过。
2. 先构建 Agent，再运行 `bun packages/project/scripts/model-guidance-audit.ts --write-reviewed`，显式记录审核结果。
3. 运行 `bun test packages/project/test/project-guidance-drift.test.ts packages/project/test/project-model-contracts.test.ts`。普通测试和发布命令只比较记录，不会自动更新记录。

`<fileRef>`、`<changeRef>` 等示例值是参数模板，使用时必须换成真实回执中的引用。示例通过 schema 只证明参数形状有效；实际执行仍检查引用的来源、会话、版本和最终可见覆盖。
