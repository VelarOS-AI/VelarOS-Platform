// mods：Agent 领域的两级注册机第二级——manifest 装载、贡献注册面、拦截 seam 与宿主组装入口。
// 唯一门面；主干之外一律经此消费，不深入子模块。
export type {
  AgentModAssembly,
  AgentModDiscoveryResult,
  AgentModPackDescriptorLike,
  AgentModPackReader,
  AssembleAgentModsInput,
} from '../impl/assembly/AgentModHostAssembler'
export { assembleAgentMods, discoverAgentModPackages } from '../impl/assembly/AgentModHostAssembler'
export type {
  BuiltinAgentModOptions,
  BuiltinAgentModPackage,
} from '../impl/builtin/BuiltinAgentMod'
export {
  BuiltinAgentModId,
  BuiltinAgentModToolCollections,
  collectBuiltinAgentModTools,
  createBuiltinAgentModPackage,
} from '../impl/builtin/BuiltinAgentMod'
export type {
  AgentModActivationState,
  AgentModActivationStatus,
  AgentModBindings,
  AgentModHostProfile,
  AgentModLoadReport,
  AgentModPackage,
  AgentModRejection,
  AgentModSourceKind,
} from '../impl/mods/AgentModLoader'
export { AgentModLoader, DataOnlyAxes, PayloadRequiredAxes } from '../impl/mods/AgentModLoader'
export type {
  AgentModAxisDeclarationMap,
  AgentModAxisPayloadMap,
  AgentModAxisRecord,
  AgentModContributionRecord,
  AgentModRegistryPhase,
  AgentModRegistrySnapshot,
} from '../impl/mods/AgentModRegistry'
export { AgentModRegistry, AgentModStaleSnapshotError } from '../impl/mods/AgentModRegistry'
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
} from '../impl/mods/AgentModSeamDispatcher'
export {
  AgentModHookDispatcher,
  AgentModSeamDispatcher,
  WiredHookEvents,
  WiredSeamKinds,
} from '../impl/mods/AgentModSeamDispatcher'
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
} from '../impl/mods/VelarModArchiveImporter'
export {
  VelarModArchiveExtension,
  VelarModArchiveImporter,
  VelarModSignatureFileName,
} from '../impl/mods/VelarModArchiveImporter'
export type { AgentModSurfaceSnapshot } from '../utils/mods/agent-mod-projection'
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
} from '../utils/mods/agent-mod-projection'
