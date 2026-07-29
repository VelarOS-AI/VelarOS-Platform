/**
 * Portable Workspace contracts for browser, renderer, worker, RPC, and test
 * consumers.
 *
 * This entry intentionally contains no filesystem, path, process, command, or
 * provider implementation. Node hosts should keep using the package root for
 * the complete Workspace runtime.
 */
export type * from './workspace-contracts.js'
export type { WorkspaceRootSource as WorkspaceRootSourceValue } from './workspace-root-source.js'
export {
  isProjectWorkspaceRootSource,
  WorkspaceRootSource,
} from './workspace-root-source.js'
export type { WorkspaceKernelToolName } from './workspace-tool-names.js'
export {
  WorkspaceDiscoveryToolNames,
  WorkspaceKernelToolNames,
  WorkspaceMutationToolNames,
} from './workspace-tool-names.js'
