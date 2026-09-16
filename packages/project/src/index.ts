/**
 * 项目空间根入口（`@velaros-ai/project`），给 Node 宿主。
 *
 * 只出三样东西：产品面（`contract/provides.ts` 登记的接口和它们的实例、工厂）、注入面（`contract/requires.ts` 的接口）、
 * 以及它们用到的数据（`types/`）与常量表（`contract/constants.ts`）。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：工具、内置 mod、内核挂载、领域内核、有限事务面、落盘变更记录、审批桥、文件上下文登记 ───────
export type { ProjectBundledModDefinition, ProjectCapabilityService, ProjectChangeFeed, ProjectCodeAnalysisToolCollection, ProjectEditTool, ProjectToolCollection, VelaTool } from './contract/provides.js'
export type { ProjectKernel } from './impl/kernel/LocalProjectKernel.js'
export { createProjectKernel } from './impl/kernel/LocalProjectKernel.js'
export { createSecretRedactionProvider } from './impl/kernel/PatternSecretRedactionProvider.js'
export type { ProjectApprovalBridgeApi } from './impl/kernel/ProjectApprovalBridge.js'
export { projectApprovalBridge } from './impl/kernel/ProjectApprovalBridge.js'
export type { ProjectTransactionControllerApi } from './impl/kernel/ProjectTransactionController.js'
export { createProjectTransactionController } from './impl/kernel/ProjectTransactionController.js'
export type { ProjectFileContextApi } from './impl/operations/ProjectFileContext.js'
export { projectFileContext } from './impl/operations/ProjectFileContext.js'
export type { FileProjectChangeFeedApi } from './impl/persistence/FileProjectChangeFeed.js'
export { createFileProjectChangeFeed } from './impl/persistence/FileProjectChangeFeed.js'
export { typescriptPlugin } from './impl/plugins/TypeScriptProjectPlugin.js'
export { createProjectBundledModDefinition, createProjectCodeAnalysisTools, createProjectKernelModule, ProjectCapability, projectTools } from './impl/ProjectTools.js'

// ── 注入面：宿主要给的东西，以及插件与扩展点 ─────────────────────────
export type {
  AgentProjectKernelPort,
  ApprovalProvider,
  CommandProvider,
  ContextProvider,
  CreateProjectKernelModuleOptions,
  CreateProjectKernelOptions,
  FileAdapter,
  FileAdapterFactory,
  FileFilterProvider,
  LoggerProvider,
  PatchStrategy,
  PipelineStage,
  PolicyProvider,
  ProjectChangeFeedWriter,
  ProjectCodeIntelligenceHost,
  ProjectFixer,
  ProjectHook,
  ProjectPlugin,
  ProjectPluginContext,
  ProjectProviders,
  ProjectSandboxPort,
  ProjectToolApi,
  ProjectToolContext,
  ProjectToolContextResolver,
  ProjectValidator,
  SecretRedactionProvider,
  TelemetryProvider,
} from './contract/requires.js'

// ── 上面两面用到、又不在可移植文件里的数据 ───────────────────────
export type { AdapterCapability, AdapterKind, AdapterPrepareEditInput, AdapterSearchHit, AdapterSearchInput, AdapterValidateInput, ParseInput, ParseResult, ProjectSymbol, SymbolInfo } from './types/adapter.js'
export type { ProjectApprovalContext, ProjectFileContextCarrier } from './types/agent.js'
export type { AgentProjectApplyResult, AgentProjectCommandToolRequirement, AgentProjectFileSnapshot, AgentProjectKernelReadResult, AgentProjectPreparedPatch, AgentProjectPreparedTransaction, AgentProjectReadContinuation, AgentProjectReadResult, AgentProjectSearchHit, AgentProjectSearchResult, AgentProjectStoredTransaction } from './types/agent-port.js'
export type { BatchConflict, BatchInput, BatchMetrics, BatchResult, BatchTask, BatchTaskOperation, BatchTaskResult } from './types/batch.js'
export type { FileProjectChangeFeedOptions, ProjectChangeLifecycle, ProjectChangeListener, ProjectChangeListOptions, ProjectChangePatch, ProjectChangeRecord, ProjectChangeRecordInput, ProjectChangeRevision } from './types/change-feed.js'
export type { Diagnostic, DiffResult, JsonValue, ProjectStatus, Range, RiskLevel, TrustLabel, TrustLevel, TrustSource } from './types/common.js'
export type { BuildEvidencePackInput, BuildEvidenceToolInput, EvidencePack, EvidenceTargetInput, EvidenceTaskInput } from './types/context.js'
export type { AddImportOperation, AmendEditInput, AppendTextOperation, ApplyEditInput, ApplyResult, CreateFileOperation, CustomEditOperation, DeleteFileOperation, DeleteTextOperation, EditConstraints, EditIntent, EditOperation, InsertAfterSymbolOperation, InsertAroundSymbolOperation, InsertBeforeSymbolOperation, InsertTextAtAnchorOperation, InsertTextOperation, JsonPatchOperation, PreparedPatch, PreparedTransaction, PrepareEditInput, PrependTextOperation, RemoveImportOperation, RenameFileOperation, ReplaceContentOperation, ReplaceLinesOperation, ReplaceSymbolOperation, ReplaceTextOperation, RollbackInput, RollbackResult } from './types/edit.js'
export type { FixFileContent, FixInput, FixResult, ProjectFixContext } from './types/fix.js'
export type { HookContext, HookEvent } from './types/hook.js'
export type { FileListEntry, FileStatInput, FileStatResult, ObserveInput, ReadInput, ReadResult, SearchHit, SearchInput, SearchResult } from './types/io.js'
export type { PatchStrategyInput } from './types/patch.js'
export type { PipelineContext, PipelinePhase } from './types/pipeline.js'
export type { TypeScriptPluginOptions } from './types/plugins.js'
export type { ApprovalRequest, CorePolicy, PolicyDecision, PolicyDecisionInput } from './types/policy.js'
export type { CommandRunInput, CommandRunResult, CommandToolRequirement, CommandToolRequirementKind, FileFilterInput, ProjectIntelligenceLocation, ProjectIntelligenceSymbol, ProjectRuntimeProviders, RedactionInput, RedactionResult } from './types/provider.js'
export type { FileAttributes, FileSnapshot, ProjectSnapshot } from './types/snapshot.js'
export type { ResolvedTarget,ResolveTargetInput, ResolveTargetResult } from './types/target.js'
export type { ProjectTransactionInput, ProjectTransactionStatus, StoredTransaction } from './types/transaction.js'
export type { Postcondition, ProjectValidationContext, ProjectValidationPolicy, ProjectValidationProviders, ProjectValidationTransaction, ReadonlyProvider, ValidateInput, ValidationCheckResult, ValidationResult } from './types/validation.js'
