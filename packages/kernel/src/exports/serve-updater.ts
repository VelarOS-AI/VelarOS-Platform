export type { KernelUpdaterErrorCode } from '../contract/constants'
export type { KernelHealthCheck } from '../contract/requires'
export type { KernelArtifactExtractor } from '../contract/requires'
export type { KernelArtifactSignatureVerifier } from '../contract/requires'
export { KernelUpdateLock, withKernelUpdateLock } from '../impl/updater/KernelUpdateLock'
export { KernelUpdater } from '../impl/updater/KernelUpdater'
export { kernelArtifactFileName, PassthroughKernelArtifactExtractor } from '../impl/updater/PassthroughKernelArtifactExtractor'
export { UnverifiedKernelArtifactSignatureVerifier } from '../impl/updater/UnverifiedKernelArtifactSignatureVerifier'
export type { KernelUpdateLockOptions, KernelUpdateLockRecord } from '../types/updater'
export type { KernelActivationOptions, KernelCompatibilityOutcome, KernelCompatibilityRequirement, KernelEnsureInstalledOptions, KernelHealthCheckContext, KernelInstallOutcome, KernelPruneOptions, KernelUpdaterOptions } from '../types/updater'
export type { KernelArtifactExtractionContext } from '../types/updater'
export type { KernelArtifactSignatureContext, KernelArtifactSignatureResult } from '../types/updater'
export type { KernelUpdaterErrorDetails } from '../utils/errors'
export { KernelUpdaterError } from '../utils/errors'
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
