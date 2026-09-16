// mods：Agent 领域的两级注册机第二级——manifest 装载、贡献注册面、拦截 seam 与宿主组装入口。
// 唯一门面；主干之外一律经此消费，不深入子模块。
export type { AgentModPackReader } from '../contract/requires.js'
export type { VelarModArchiveSignatureVerifier } from '../contract/requires.js'
export { assembleAgentMods, discoverAgentModPackages } from '../impl/assembly/AgentModHostAssembler'
export {
  BuiltinAgentModId,
  BuiltinAgentModToolCollections,
  collectBuiltinAgentModTools,
  createBuiltinAgentModPackage,
} from '../impl/builtin/BuiltinAgentMod'
export { AgentModStaleSnapshotError } from '../impl/errors/AgentModStaleSnapshotError'
export { AgentModLoader, DataOnlyAxes, PayloadRequiredAxes } from '../impl/mods/AgentModLoader'
export { AgentModRegistry } from '../impl/mods/AgentModRegistry'
export {
  AgentModHookDispatcher,
  AgentModSeamDispatcher,
  WiredHookEvents,
  WiredSeamKinds,
} from '../impl/mods/AgentModSeamDispatcher'
export type { VelarModArchiveImporterOptions } from '../impl/mods/VelarModArchiveImporter'
export {
  VelarModArchiveExtension,
  VelarModArchiveImporter,
  VelarModSignatureFileName,
} from '../impl/mods/VelarModArchiveImporter'
export type { BuiltinAgentModOptions, BuiltinAgentModPackage } from '../types/builtin.js'
export type { AgentModHookEventMap, AgentModHookGenericEvent, AgentModHookHandler, AgentModHookOutcomeMap, AgentModHookRegistration, AgentModHookRegistrationInput } from '../types/mods.js'
export type { AgentModAssembly, AgentModDiscoveryResult, AgentModPackDescriptorLike, AssembleAgentModsInput } from '../types/mods.js'
export type { InstallScannedVelarModArchiveRequest, PreparedVelarModInstall, VelarModArchiveEntry, VelarModArchiveFinding, VelarModArchiveInstallFailureReason, VelarModArchiveScanReport, VelarModPermissionDescriptor } from '../types/mods.js'
export type { AgentModAxisDeclarationMap, AgentModAxisPayloadMap, AgentModAxisRecord, AgentModContributionRecord, AgentModRegistryPhase, AgentModRegistrySnapshot } from '../types/mods.js'
export type { AgentModActivationState, AgentModActivationStatus, AgentModBindings, AgentModHostProfile, AgentModLoadReport, AgentModPackage, AgentModRejection, AgentModSourceKind } from '../types/mods.js'
export type { AgentModHookContext, AgentModSeamEventMap, AgentModSeamGenericEvent, AgentModSeamHandler, AgentModSeamOutcomeMap, AgentModSeamRegistration, AgentModSeamRegistrationInput, AgentModSessionLifecycleEvent, AgentModToolCallBeforeEvent, AgentModToolCallBeforeOutcome, AgentModToolResultAfterEvent, AgentModToolResultAfterOutcome, AgentModTurnContextAppendage, AgentModTurnContextAssembleEvent, AgentModTurnContextAssembleOutcome, AgentModTurnContextSegmentView } from '../types/mods.js'
export type { AgentModSurfaceSnapshot } from '../types/mods.js'
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
