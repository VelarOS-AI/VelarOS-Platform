# Agent 测试迁移台账

这是合同迁移清单，不将旧用例数量计入新测试通过数。旧循环的对象结构断言随对应公开 API 退出；仍适用的行为在当前链路重新验收。逐文件如下。

| 旧文件 | 新归属与迁移理由 |
| --- | --- |
| `test/AgentSessionLifecycle.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/ExternalAgentBridgeState.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/McpClientConnection.test.ts` | velaros/test/McpClientConnection.test.ts：连接、分页、取消、鉴权保留原断言 |
| `test/SessionApplicationServices.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/VelarModArchiveImporter.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/activeDirectives.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/agentCapabilityWire.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/agentDispatchInputContract.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/agentExecutionStack.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/backgroundJobLineageSettlement.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/backgroundJobOutputFilter.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/backgroundJobsWaitAny.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/builtinToolCapabilityTruth.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/capability-boundary.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/capabilityExtensions.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/capabilityObservability.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/capabilityRunPlannerResidency.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/chatKernelSubmission.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/chatMessageConversationSemantics.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/cloudApiErrorRetry.test.mjs` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/confirmationIdentity.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/contextAutomaticToolSurface.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextGovernanceAccounting.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextGovernanceDistill.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextGovernanceEpoch.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextGovernanceSessionIdentity.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextGovernanceWindowReconciliation.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextGovernanceWiringSeams.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextResidencyLedger.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextRetrievalRankingPathHints.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextRetrievalRecall.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/contextRetrievalReferenceReader.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/dualCoreCompiler.test.ts` | model/test/act-compiler.test.ts 与 agent/spec/acceptance.test.ts：请求封存、计量与取消 |
| `test/executionIdFactory.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/executionLimits.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/executionModeAxis.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/executionPolicyFailures.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/executionProgress.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/executionShutdown.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/fileContext.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/finishingGateInterceptionScope.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/fixtures/provider-request-basic.json` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/goalBlockedLifecycle.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/historicalBinarySanitize.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/historyStructureRepair.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/hostCompositionDefaults.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/hostModelRetryPolicy.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/kernel-module.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/managedExecutionTerminalOwnership.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/manualApprovalOptions.test.ts` | kernel/test/manualApprovalOptions.test.ts：手工确认合同迁移 |
| `test/mcpCallResult.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/mcpToolTranslation.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/modSeamToolChain.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/model-boundary.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/modelInputCompatibility.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/modelRequestError.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/modelSpanIdentity.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/mods.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/outputTruncationRecovery.test.mjs` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/planLifecycle.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/privateFileRecords.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/projectReadSerialization.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/promptRuntimeAvailability.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/promptTierStructure.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/protocol/external-agent-bridge.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/protocol/mods.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/protocol/observability.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/protocol/product-surface.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/providerRequestTranscript.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/providerRetainedContext.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/providerToolResponseIdentity.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/runCompletion.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/runContextTurnIsolation.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/runProfileBudgetContract.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/runtimeInputSettlement.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/runtimeInputStreamPreemption.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/skillsRequiredSpaces.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/soloBackgroundCompletionGate.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/soloGoalLifecycle.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/soloProcessUpdateCadence.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/standaloneModuleImport.test.ts` | Kernel 现有 mod/remote-node 验收及 Velaros capability module：扩展走能力/来源注入；修改循环的 seam 和产品桥协议退出 |
| `test/streamIdleThinkingNotice.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/streamReasoningSingleSource.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/structuredOutputFence.test.ts` | model/test、velaros/test/provider.test.ts、text-decoder.test.mjs、text-runtime.test.mjs：真实请求与 ScriptAct 协议；旧 tool-call 消息修复合同退出 |
| `test/subAgentBackgroundCommandBoundary.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/subAgentDispatchCatalog.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/subAgentGuidanceRelayDelivery.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/subAgentModelSelection.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/subAgentThreadRetention.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/subAgentToolActivationCancellation.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
| `test/taskApproval.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/taskApprovalDisposal.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/taskLedgerSelfStep.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/toolArgsSchemaValidator.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolCallDeduper.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolCallableOperations.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolContractExecutionFacade.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/toolDescriptionBudget.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolDescriptions.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolDiscoveryUsability.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolEmptyOutput.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolExampleWireShape.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolExecutionLifecycle.test.ts` | velaros/test/act-run.test.mjs、runtime.test.mjs 与 kernel/test/act-approval.test.ts：运行身份、引导、等待、审批、恢复；原状态机对象测试退出 |
| `test/toolExposureBudget.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolIdentity.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolInputHistoryReplay.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolInputReuse.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolOutputStoreSourceWindows.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolPayloadReferencePlanner.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/toolPromptFeatureLease.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolResultSerializationHistoryPreview.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolSchemas.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolSpaceFindProjection.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolSpaceMapErgonomics.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolSpaceReplaceConflicts.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolSpaceReplaceResidency.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/toolSpaceUserActionBinding.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/transientRecoveryProjection.test.ts` | velaros/test/act-run.test.mjs 与 act-children.test.mjs：持久运行和事件投影；旧 Agent 内部对象合同退出 |
| `test/turnCapabilitySnapshot.test.ts` | context/test/context.test.mjs 与 velaros/test/platform.test.mjs、runtime.test.mjs：唯一模块定义、参数及结果校验、执行模式；供应商工具传输/驻留/自动复用合同退出 |
| `test/turnContextStateSource.test.ts` | context/test/turnContextStateSource.test.ts：原活动账本断言迁移 |
| `test/userTextContext.test.ts` | context/test、velaros/test/context-management.test.mjs 与 program-context.test.mjs：原文引用、预算、版本、租约；驻留/治理算法随旧协议退出 |
| `test/workflowDispatchLimits.test.ts` | agent/spec/acceptance.test.ts 与 velaros/test/act-children.test.mjs、text-runtime.test.mjs：统一子运行、JS 编排、后台和取消；旧职业角色及 workflow IR 退出 |
