/** Stable protocol names owned by the Workspace capability package. */
export const WorkspaceKernelToolNames = {
  status: 'ws_status',
  read: 'ws_read',
  stat: 'ws_file_stat',
  search: 'ws_search',
  listFiles: 'ws_list_files',
  symbols: 'ws_symbols',
  resolveTarget: 'ws_resolve_target',
  buildEvidence: 'ws_build_evidence',
  diff: 'ws_diff',
  prepareEdit: 'ws_prepare_edit',
  amendEdit: 'ws_amend_edit',
  edit: 'ws_edit',
  commitEdit: 'ws_commit_edit',
  applyEdit: 'ws_apply_edit',
  validate: 'ws_validate',
  rollback: 'ws_rollback',
  runBatch: 'ws_run_batch',
  runCommand: 'ws_run_command',
} as const

export type WorkspaceKernelToolName =
  (typeof WorkspaceKernelToolNames)[keyof typeof WorkspaceKernelToolNames]

export const WorkspaceDiscoveryToolNames: readonly WorkspaceKernelToolName[] = [
  WorkspaceKernelToolNames.search,
  WorkspaceKernelToolNames.stat,
  WorkspaceKernelToolNames.listFiles,
  WorkspaceKernelToolNames.symbols,
  WorkspaceKernelToolNames.resolveTarget,
  WorkspaceKernelToolNames.buildEvidence,
  WorkspaceKernelToolNames.diff,
  WorkspaceKernelToolNames.status,
] as const

export const WorkspaceMutationToolNames: readonly WorkspaceKernelToolName[] = [
  WorkspaceKernelToolNames.commitEdit,
  WorkspaceKernelToolNames.amendEdit,
  WorkspaceKernelToolNames.edit,
  WorkspaceKernelToolNames.applyEdit,
  WorkspaceKernelToolNames.rollback,
  WorkspaceKernelToolNames.runBatch,
] as const
