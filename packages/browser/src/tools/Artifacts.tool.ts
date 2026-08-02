import { type z } from 'zod'

import {
  listBrowserWorkspaceArtifacts,
  listBrowserWorkspaceFiles,
  readBrowserWorkspaceFile,
  saveBrowserPageSnapshot,
  writeBrowserWorkspaceArtifact,
  writeBrowserWorkspaceFile,
} from './Artifacts'
import { browserFilesSchema, parseBrowserFilesInput } from './BrowserFilesSchema'
import { BrowserArtifactWriteCapability } from './Capabilities'
import { defineBrowserTool } from './Types'

/** 浏览器网站工作区文件与结构化 artifact 的统一原语入口。 */
const browserFiles = defineBrowserTool<z.input<typeof browserFilesSchema>>({
  name: 'browser:files',
  role: 'edit',
  summary: '统一管理当前网站浏览器工作区文件和结构化 artifact。',
  suitable: [
    '需要列出、读取或写入当前网站工作区文件。',
    '需要列出/写入标准 artifact，或保存当前页面快照。',
  ],
  forbidden: ['不要用它跨网站访问其他 browser 工作区。', '读取文件必须传 endLine 或 maxChars。'],
  protocol: [
    'action=list_files/read_file/write_file 对应普通路径。',
    'action=list_artifacts/write_artifact/save_page_snapshot 对应标准 artifact 目录。',
  ],
  usage: ['传 action，再按 action 提供对应参数；覆盖已有内容必须显式 overwrite=true。'],
  examples: [
    // 列出工作区文件（limit 必填）
    { action: 'list_files', limit: 100 },
    // 读取文件：必须传 maxChars 或 endLine
    { action: 'read_file', path: 'recipes/login.json', maxChars: 12000 },
    // 写普通文件；覆盖已有必须 overwrite=true
    { action: 'write_file', path: 'notes/todo.md', content: '# TODO\n- ...' },
    // 列出标准 artifact
    { action: 'list_artifacts', kind: 'extract', limit: 50 },
    // 写结构化 artifact
    { action: 'write_artifact', kind: 'extract', format: 'json', content: '{...}' },
    // 保存当前页面快照
    { action: 'save_page_snapshot', name: 'login-page' },
  ],
  notes: [
    '这是 browser 文件/产物的唯一公开入口；内部按 action 分派到有界读写实现。',
    'write_file 返回 absolute path 供本机文件链接打开，并返回 relativePath 供展示和持久化。',
  ],
  schema: browserFilesSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    const parsed = parseBrowserFilesInput(input)
    switch (parsed.action) {
      case 'list_files':
        return listBrowserWorkspaceFiles(parsed, ctx)
      case 'read_file':
        return readBrowserWorkspaceFile(parsed, ctx)
      case 'write_file':
        return writeBrowserWorkspaceFile(parsed, ctx)
      case 'list_artifacts':
        return listBrowserWorkspaceArtifacts(parsed, ctx)
      case 'write_artifact':
        return writeBrowserWorkspaceArtifact(parsed, ctx)
      case 'save_page_snapshot':
        return saveBrowserPageSnapshot(parsed, ctx)
    }
  },
})

/** browser 工作区文件/artifact 工具出口。 */
const browserArtifactTools = {
  'browser:files': browserFiles,
}

export { browserArtifactTools }
