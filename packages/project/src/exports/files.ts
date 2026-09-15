export type { ProjectPathPlatform } from '../types/files.js'
export type * from '../types/io.js'
export type * from '../types/snapshot.js'
export * from '../utils/files/path-containment.js'
export {
  ProjectDiscoverySkippedDirectoryNames,
  ProjectExcludedDirectoryNames,
  ProjectHiddenDirectoryAllowlist,
  ProjectModelRestrictedDirectoryNames,
  shouldRestrictProjectModelPathSegment,
  shouldSkipProjectDirectory,
  shouldSkipProjectDiscoveryDirectory,
} from '../utils/files/visibility.js'
