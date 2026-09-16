import type { BrowserRecipeTemplate } from '../utils/recipes/skeleton.js'

import type { BrowserPageInspection,BrowserSiteContext, BrowserUserScriptRecord, BrowserWorkspaceArtifactFormat, BrowserWorkspaceArtifactKind, ProjectReadFileResult, WorkspaceFileEntry, WorkspaceListOptions, WorkspaceWriteFileOptions, WorkspaceWriteFileResult } from './browser.js'

/** 站点工作区里的一条路径。 */
export interface BrowserWorkspacePath {
  /** 解开符号链接后的真实绝对路径：包含判定与落盘都用它。 */
  path: string
  /** 相对工作区根的可移植相对路径（各级用 `/` 连接；根本身是 `.`）。 */
  relativePath: string
  /** 没解链接、只把相对路径接到根上的字面绝对路径：判「这一段本身是不是符号链接」时用。 */
  literalPath: string
}

export interface BrowserWorkspaceResolvedPath {
  path: string
  root: string
}

/** BrowserWorkspaceArtifactManager 需要的文件系统访问接口。 */
export interface BrowserWorkspaceArtifactAccess {
  readFile: (
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ) => Promise<ProjectReadFileResult>
  writeFile: (
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ) => Promise<WorkspaceWriteFileResult>
  listFiles: (options?: WorkspaceListOptions) => Promise<WorkspaceFileEntry[]>
}

/** 写入通用浏览器 artifact 的输入。 */
export interface WriteBrowserArtifactInput {
  context: BrowserSiteContext
  kind: BrowserWorkspaceArtifactKind
  format: BrowserWorkspaceArtifactFormat
  content: string
  name?: string
  overwrite?: boolean
}

/** 保存页面快照输入。 */
export interface SaveBrowserPageSnapshotInput {
  context: BrowserSiteContext
  inspection: BrowserPageInspection
  name?: string
  overwrite?: boolean
}

/** 保存 recipe skeleton 输入。 */
export interface SaveBrowserRecipeSkeletonInput {
  context: BrowserSiteContext
  inspection: BrowserPageInspection
  sourceSnapshotPath?: LooseOptional<string>
  name?: string
  overwrite?: boolean
  /** C3: 预设模板名，自动在 suggestedSteps 前插入常用操作步骤骨架 */
  template?: BrowserRecipeTemplate
}

export interface BrowserUserScriptAccess {
  readFile: (
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ) => Promise<ProjectReadFileResult>
  writeFile: (
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ) => Promise<WorkspaceWriteFileResult>
  deleteFile: (path: string) => Promise<{ path: string; deleted: boolean }>
}

export interface BrowserUserScriptStore {
  version: 1
  globalEnabled: boolean
  scripts: BrowserUserScriptRecord[]
}

/** updateScript 校验完成后、写盘之前的最终值；`null` 表示这次不改这个字段。 */
export interface BrowserUserScriptValidatedPatch {
  code: Nullable<string>
  name: Nullable<string>
  /** 用一层包装区分「不改」（null）与「改成空」（{ value: undefined }）。 */
  description: Nullable<{ value: LooseOptional<string> }>
  match: Nullable<string[]>
  excludeMatch: Nullable<string[]>
  version: Nullable<string>
}
