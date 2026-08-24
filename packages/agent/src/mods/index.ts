// mods：Agent 领域的两级注册机第二级——manifest 装载、贡献注册面、拦截 seam 与宿主组装入口。
// 唯一门面；主干之外一律经此消费，不深入子模块。
export type {
  AgentModAssembly,
  AgentModDiscoveryResult,
  AgentModPackDescriptorLike,
  AgentModPackReader,
  AssembleAgentModsInput,
} from './AgentModHostAssembly'
export { assembleAgentMods, discoverAgentModPackages } from './AgentModHostAssembly'
export type {
  AgentModActivationState,
  AgentModActivationStatus,
  AgentModBindings,
  AgentModHostProfile,
  AgentModLoadReport,
  AgentModPackage,
  AgentModRejection,
  AgentModSourceKind,
} from './AgentModLoader'
export { AgentModLoader, DataOnlyAxes, PayloadRequiredAxes } from './AgentModLoader'
export type { AgentModSurfaceSnapshot } from './AgentModProjection'
export {
  composeAgentModSpaces,
  createAgentModSurfaceSnapshot,
  projectAgentModExecutionModes,
  projectAgentModPromptSegments,
  projectAgentModSkills,
  projectAgentModSpaces,
  projectAgentModSubAgentTypes,
  projectAgentModToolCategories,
  projectAgentModTools,
  projectAgentModTurnContextSources,
} from './AgentModProjection'
export type {
  AgentModAxisDeclarationMap,
  AgentModAxisPayloadMap,
  AgentModAxisRecord,
  AgentModContributionRecord,
  AgentModRegistryPhase,
  AgentModRegistrySnapshot,
} from './AgentModRegistry'
export { AgentModRegistry, AgentModStaleSnapshotError } from './AgentModRegistry'
export type {
  AgentModHookContext,
  AgentModHookEventMap,
  AgentModHookGenericEvent,
  AgentModHookHandler,
  AgentModHookOutcomeMap,
  AgentModHookRegistration,
  AgentModHookRegistrationInput,
  AgentModSeamEventMap,
  AgentModSeamGenericEvent,
  AgentModSeamHandler,
  AgentModSeamOutcomeMap,
  AgentModSeamRegistration,
  AgentModSeamRegistrationInput,
  AgentModSessionLifecycleEvent,
  AgentModToolCallBeforeEvent,
  AgentModToolCallBeforeOutcome,
  AgentModToolResultAfterEvent,
  AgentModToolResultAfterOutcome,
  AgentModTurnContextAppendage,
  AgentModTurnContextAssembleEvent,
  AgentModTurnContextAssembleOutcome,
  AgentModTurnContextSegmentView,
} from './AgentModSeams'
export {
  AgentModHookDispatcher,
  AgentModSeamDispatcher,
  WiredHookEvents,
  WiredSeamKinds,
} from './AgentModSeams'
export type {
  BuiltinAgentModOptions,
  BuiltinAgentModPackage,
} from './BuiltinAgentMod'
export {
  BuiltinAgentModId,
  BuiltinAgentModToolCollections,
  collectBuiltinAgentModTools,
  createBuiltinAgentModPackage,
} from './BuiltinAgentMod'
export type {
  InstallScannedVelarModArchiveRequest,
  PreparedVelarModInstall,
  VelarModArchiveEntry,
  VelarModArchiveFinding,
  VelarModArchiveImporterOptions,
  VelarModArchiveInstallFailureReason,
  VelarModArchiveScanReport,
  VelarModArchiveSignatureVerifier,
  VelarModPermissionDescriptor,
} from './VelarModArchiveImporter'
export {
  VelarModArchiveExtension,
  VelarModArchiveImporter,
  VelarModSignatureFileName,
} from './VelarModArchiveImporter'
