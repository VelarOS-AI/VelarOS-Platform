const PrivateFileRecordNames = new Set([
  '__project_file_reference__', '__project_edit_target__',
  '__file_snapshot__', '__file_observation__', '__file_rename__',
])

/**
 * 这个「工具名」是不是文件上下文的内部记录名（`__file_snapshot__`、`__project_edit_target__` 等五种之一）。
 * 为真的记录归授权过的文件上下文 API 所有，不参与通用会话检索——不挡住的话，模型一条普通召回就能把文件快照当普通工具结果翻出来。
 * 名字缺席或不在登记表里一律为假，判定按精确匹配，不做前缀或模糊比对。
 */
export function isPrivateFileContextRecord(toolName: LooseOptional<string>): boolean {
  return !!toolName && PrivateFileRecordNames.has(toolName)
}
