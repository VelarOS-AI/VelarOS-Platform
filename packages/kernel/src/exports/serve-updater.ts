export type { KernelUpdateLockOptions, KernelUpdateLockRecord } from '../impl/updater/KernelUpdateLock'
export { KernelUpdateLock, withKernelUpdateLock } from '../impl/updater/KernelUpdateLock'
export type {
  KernelActivationOptions,
  KernelCompatibilityOutcome,
  KernelCompatibilityRequirement,
  KernelEnsureInstalledOptions,
  KernelHealthCheck,
  KernelHealthCheckContext,
  KernelInstallOutcome,
  KernelPruneOptions,
  KernelUpdaterOptions,
} from '../impl/updater/KernelUpdater'
export { KernelUpdater } from '../impl/updater/KernelUpdater'
export type { KernelArtifactExtractionContext, KernelArtifactExtractor } from '../impl/updater/PassthroughKernelArtifactExtractor'
export { kernelArtifactFileName, PassthroughKernelArtifactExtractor } from '../impl/updater/PassthroughKernelArtifactExtractor'
export type {
  KernelArtifactSignatureContext,
  KernelArtifactSignatureResult,
  KernelArtifactSignatureVerifier,
} from '../impl/updater/UnverifiedKernelArtifactSignatureVerifier'
export { UnverifiedKernelArtifactSignatureVerifier } from '../impl/updater/UnverifiedKernelArtifactSignatureVerifier'
export type {
  KernelArtifactVerificationErrorCode,
  KernelUpdaterErrorCode,
  KernelUpdaterErrorDetails,
} from '../utils/errors-updater'
export {
  KernelArtifactVerificationError,
  KernelUpdateLockError,
  KernelUpdaterError,
} from '../utils/errors-updater'
export type { KernelArtifactDownloadOptions, KernelArtifactDownloadResult } from '../utils/updater/download'
export { downloadKernelArtifact } from '../utils/updater/download'
export type { KernelInstalledVersion, KernelInstallRecord } from '../utils/updater/installation'
export {
  KernelInstallRecordFileName,
  KernelInstallRecordSchema,
  listKernelInstalledVersions,
  readKernelInstallRecord,
  writeKernelInstallRecord,
} from '../utils/updater/installation'
export type { KernelInstallLayout } from '../utils/updater/layout'
export {
  createKernelInstallLayout,
  defaultKernelInstallRoot,
  ensureKernelInstallLayout,
  KernelInstallRootVariable,
  kernelVersionDirectory,
} from '../utils/updater/layout'
export type {
  KernelArchitecture,
  KernelArtifact,
  KernelArtifactFormat,
  KernelArtifactSelection,
  KernelArtifactTarget,
  KernelManifestLoadOptions,
  KernelManifestQuery,
  KernelManifestVersion,
  KernelPlatform,
  KernelUpdateManifest,
} from '../utils/updater/manifest'
export {
  findKernelManifestVersion,
  KernelArchitectureSchema,
  KernelArtifactFormatSchema,
  KernelArtifactSchema,
  KernelArtifactTargets,
  KernelArtifactTargetSchema,
  KernelManifestVersionSchema,
  KernelPlatformSchema,
  KernelUpdateManifestSchema,
  KernelVersionSchema,
  listKernelManifestVersions,
  loadKernelUpdateManifest,
  parseKernelUpdateManifest,
  resolveKernelArtifactTarget,
  selectKernelArtifact,
  selectKernelManifestVersion,
} from '../utils/updater/manifest'
export type { KernelActivePointer } from '../utils/updater/pointer'
export {
  KernelActivePointerSchema,
  parseKernelActivePointer,
  readKernelActivePointer,
  writeKernelActivePointer,
} from '../utils/updater/pointer'
export type { KernelFetch, KernelFetchRequest, KernelFetchResponse } from '../utils/updater/transport'
export {
  fetchKernelText,
  isRemoteKernelUrl,
  MaximumKernelManifestBytes,
  nodeKernelFetch,
} from '../utils/updater/transport'
export type { KernelSemanticVersion } from '../utils/updater/version'
export {
  assertKernelVersion,
  compareKernelVersions,
  isKernelVersion,
  KernelVersionPattern,
  parseKernelVersion,
  satisfiesKernelVersionRange,
} from '../utils/updater/version'
