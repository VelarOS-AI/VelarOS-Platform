const PrivateFileRecordNames = new Set([
  '__project_file_reference__', '__project_edit_target__',
  '__file_snapshot__', '__file_observation__', '__file_rename__',
])

/** These records are owned by authorized file-context APIs, not generic conversation retrieval. */
export function isPrivateFileContextRecord(toolName: LooseOptional<string>): boolean {
  return !!toolName && PrivateFileRecordNames.has(toolName)
}
