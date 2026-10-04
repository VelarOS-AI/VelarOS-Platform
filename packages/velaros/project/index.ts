/**
 * 项目单元根入口（`@velaros-ai/velaros/project`），给 Node 宿主：`velaros:project` 与 `velaros:code` 两件工具，连同项目内核，
 * 以及项目给共用能力（命令、沙箱、看图）装的端口与验证判据。
 *
 * 只出三样东西：产品面（`contract/provides.ts` 登记的接口和它们的实例、工厂）、注入面（`contract/requires.ts` 的接口）、
 * 以及它们用到的数据（`types/`）与常量表（`contract/constants.ts`）。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 * 把这两件工具与共用能力装成项目空间是产品的事：产品每次分发调用时给宿主端口，从 `projectCapabilityPorts` 取共用能力的项目端口。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：项目文件、代码理解、项目资源门、共用能力的项目端口、验证判据、领域内核、有限事务面、落盘变更记录 ───────
export type { ProjectChangeFeed } from './contract/provides.js'
export type { ProjectKernel } from './impl/kernel/LocalProjectKernel.js'
export { createProjectKernel } from './impl/kernel/LocalProjectKernel.js'
export type { ProjectTransactionControllerApi } from './impl/kernel/ProjectTransactionController.js'
export { createProjectTransactionController } from './impl/kernel/ProjectTransactionController.js'
export type { ProjectCapabilityPortsApi } from './impl/operations/ProjectCapabilityPorts.js'
export { projectCapabilityPorts } from './impl/operations/ProjectCapabilityPorts.js'
export type { ProjectCodeOperationsApi } from './impl/operations/ProjectCodeOperations.js'
export { projectCodeOperations } from './impl/operations/ProjectCodeOperations.js'
export type { ProjectExecutionGateApi } from './impl/operations/ProjectExecutionGate.js'
export { projectExecutionGate } from './impl/operations/ProjectExecutionGate.js'
export type { ProjectFileOperationsApi } from './impl/operations/ProjectFileOperations.js'
export { projectFileOperations } from './impl/operations/ProjectFileOperations.js'
export type { ProjectObservationProviderApi } from './impl/operations/ProjectObservationProvider.js'
export { createProjectObservationProvider } from './impl/operations/ProjectObservationProvider.js'
export type { ProjectVerificationPolicyApi } from './impl/operations/ProjectVerificationPolicy.js'
export { projectVerificationPolicy } from './impl/operations/ProjectVerificationPolicy.js'
export type { FileProjectChangeFeedApi } from './impl/persistence/FileProjectChangeFeed.js'
export { createFileProjectChangeFeed } from './impl/persistence/FileProjectChangeFeed.js'
export { typescriptPlugin } from './impl/plugins/TypeScriptProjectPlugin.js'

// ── 注入面：宿主要给的东西，以及插件与扩展点 ─────────────────────────
export type {
  AgentProjectKernelPort,
  CommandProvider,
  ContextProvider,
  CreateProjectKernelOptions,
  FileAdapter,
  FileAdapterFactory,
  FileFilterProvider,
  LoggerProvider,
  PatchStrategy,
  PipelineStage,
  ProjectChangeFeedWriter,
  ProjectCodeIntelligenceHost,
  ProjectFixer,
  ProjectHook,
  ProjectHostPort,
  ProjectImagesHost,
  ProjectOperationContext,
  ProjectPlugin,
  ProjectPluginContext,
  ProjectProviders,
  ProjectShellHostPort,
  ProjectSpacePort,
  ProjectValidator,
  TelemetryProvider,
} from './contract/requires.js'

// ── 上面两面用到、又不在可移植文件里的数据 ───────────────────────
export type { ProjectContextSourceOptions } from './contract/requires.js'
export type { ProjectContextSourceApi } from './impl/operations/ProjectContextSource.js'
export { createProjectContextSource } from './impl/operations/ProjectContextSource.js'
export type {
  AdapterCapability,
  AdapterKind,
  AdapterPrepareEditInput,
  AdapterSearchHit,
  AdapterSearchInput,
  AdapterValidateInput,
  ParseInput,
  ParseResult,
  ProjectSymbol,
  SymbolInfo,
} from './types/adapter.js'
export type {
  AgentProjectApplyResult,
  AgentProjectCommandToolRequirement,
  AgentProjectFileSnapshot,
  AgentProjectKernelReadResult,
  AgentProjectPreparedPatch,
  AgentProjectPreparedTransaction,
  AgentProjectReadResult,
  AgentProjectSearchHit,
  AgentProjectSearchResult,
  AgentProjectStoredTransaction,
} from './types/agent-port.js'
export type {
  BatchConflict,
  BatchInput,
  BatchMetrics,
  BatchResult,
  BatchTask,
  BatchTaskOperation,
  BatchTaskResult,
} from './types/batch.js'
export type {
  FileProjectChangeFeedOptions,
  ProjectChangeLifecycle,
  ProjectChangeListener,
  ProjectChangeListOptions,
  ProjectChangePatch,
  ProjectChangeRecord,
  ProjectChangeRecordInput,
  ProjectChangeRevision,
} from './types/change-feed.js'
export type {
  CodeAnalysisInput,
  CodeQueryInput,
  CodeResult,
  CodeResultCoverage,
  CodeResultSource,
  CodeTarget,
} from './types/code.js'
export type {
  Diagnostic,
  DiffResult,
  JsonValue,
  ProjectStatus,
  Range,
  RiskLevel,
  TrustLabel,
  TrustLevel,
  TrustSource,
} from './types/common.js'
export type {
  BuildEvidencePackInput,
  BuildEvidenceToolInput,
  EvidencePack,
  EvidenceTargetInput,
  EvidenceTaskInput,
} from './types/context.js'
export type {
  AddImportOperation,
  AmendEditInput,
  AppendTextOperation,
  ApplyEditInput,
  ApplyResult,
  CreateFileOperation,
  CustomEditOperation,
  DeleteFileOperation,
  DeleteTextOperation,
  EditConstraints,
  EditIntent,
  EditOperation,
  InsertAfterSymbolOperation,
  InsertAroundSymbolOperation,
  InsertBeforeSymbolOperation,
  InsertTextAtAnchorOperation,
  InsertTextOperation,
  JsonPatchOperation,
  PreparedPatch,
  PreparedTransaction,
  PrepareEditInput,
  PrependTextOperation,
  RemoveImportOperation,
  RenameFileOperation,
  ReplaceContentOperation,
  ReplaceLinesOperation,
  ReplaceSymbolOperation,
  ReplaceTextOperation,
  RollbackInput,
  RollbackResult,
} from './types/edit.js'
export type {
  ProjectChangeInput,
  ProjectChangeInspection,
  ProjectEditInput,
  ProjectEditResult,
  ProjectEditStep,
  ProjectEntry,
  ProjectLineRange,
  ProjectListInput,
  ProjectListResult,
  ProjectReadInput,
  ProjectReadIssue,
  ProjectReadItem,
  ProjectReadResult,
  ProjectRecodeEncoding,
  ProjectRecodeNewline,
  ProjectRecodeReceipt,
  ProjectSearchHit,
  ProjectSearchInput,
  ProjectSearchRange,
  ProjectSearchResult,
  ProjectUndoResult,
  ProjectWindow,
} from './types/files.js'
export type { FixFileContent, FixInput, FixResult, ProjectFixContext } from './types/fix.js'
export type { HookContext, HookEvent } from './types/hook.js'
export type {
  FileListEntry,
  FileStatInput,
  FileStatResult,
  ObserveInput,
  ReadInput,
  ReadResult,
  SearchHit,
  SearchInput,
  SearchResult,
} from './types/io.js'
export type { PatchStrategyInput } from './types/patch.js'
export type { PipelineContext, PipelinePhase } from './types/pipeline.js'
export type { TypeScriptPluginOptions } from './types/plugins.js'
export type { CorePolicy } from './types/policy.js'
export type {
  CommandRunInput,
  CommandRunResult,
  CommandToolRequirement,
  CommandToolRequirementKind,
  FileFilterInput,
  ProjectIntelligenceLocation,
  ProjectIntelligenceSymbol,
  ProjectRuntimeProviders,
} from './types/provider.js'
export type {
  ProjectEditSummary,
  ProjectPatchAmendment,
  ProjectPatchEdit,
  ProjectPatchInput,
  ProjectPatchIssue,
  ProjectPatchResult,
  ProjectSelectedSource,
  ProjectSelectInput,
  ProjectSelection,
  ProjectSelectIssue,
  ProjectSelectResult,
  ProjectSelectTarget,
} from './types/selection.js'
export type { FileAttributes, FileSnapshot, ProjectSnapshot } from './types/snapshot.js'
export type { ResolvedTarget, ResolveTargetInput, ResolveTargetResult } from './types/target.js'
export type {
  ProjectTransactionInput,
  ProjectTransactionStatus,
  StoredTransaction,
} from './types/transaction.js'
export type {
  Postcondition,
  ProjectValidationContext,
  ProjectValidationPolicy,
  ProjectValidationProviders,
  ProjectValidationTransaction,
  ReadonlyProvider,
  ValidateInput,
  ValidationCheckResult,
  ValidationResult,
} from './types/validation.js'

// ── 注入面：宿主要塞进来的东西 ───────────────────────────────────
export type {
  LanguageReadPort,
  LanguageToolContext,
  ProjectCodeIndexApi,
} from './contract/requires.js'

// ── 产品面：语言查询 ─────────────────────────────────────────────
export type { LanguageQueriesApi } from './impl/language/LanguageQueries.js'
export { languageQueries } from './impl/language/LanguageQueries.js'

// ── 产品面：project 的 queryCode ─────────────────────────────────
export { createProjectCodeQuery } from './impl/language/ProjectCodeQuery.js'

// ── 产品面：外部语言服务 ─────────────────────────────────────────
export type { ExternalLanguageServiceApi } from './impl/language/ExternalLanguageService.js'
export { createExternalLanguageService } from './impl/language/ExternalLanguageService.js'

// ── 产品面：TypeScript 项目池 ────────────────────────────────────
export type { TypeScriptProjectsApi } from './impl/language/TypeScriptProjectPool.js'
export { typeScriptProjects } from './impl/language/TypeScriptProjectPool.js'
