import { markItDownBinaryResolver } from './markitdownResolver'
import {
  type ConvertDocumentToMarkdownInput,
  convertDocumentToMarkdownSchema,
  executeConvertDocumentToMarkdown,
} from './markitdownTool'
import {
  defineOfficeTool,
  OfficeDocumentProcessCapability,
  toolRequiresProject,
} from './officeShared'

const convertDocumentToMarkdown = defineOfficeTool<ConvertDocumentToMarkdownInput>({
  name: 'office:convert_document_to_markdown',
  role: 'inspect',
  summary: '用 MarkItDown 将工作区文档转换成 Markdown，便于模型读取。',
  suitable: ['需要把 PDF、Office、HTML 或结构化文本文件转换成模型可读 Markdown。'],
  forbidden: ['不要用它读取工作区外路径或远程 URL。', '不要把它当成高保真排版转换器。'],
  protocol: ['先传工作区内 inputPath；需要持久化结果时再传 outputPath。'],
  usage: ['传 inputPath；可选 outputPath 写入 .md；用 maxChars 控制返回文本长度。'],
  examples: [{ inputPath: 'report.pdf', outputPath: 'report.md', maxChars: 40000 }],
  notes: ['使用随应用打包的 Microsoft MarkItDown runtime，不要求用户自行安装 CLI。'],
  schema: convertDocumentToMarkdownSchema,
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: OfficeDocumentProcessCapability,
  hideWhenUnavailable: true,
  isAvailable: (ctx) => toolRequiresProject(ctx) && !!markItDownBinaryResolver.resolve(),
  isConcurrencySafe: (input) => !input.outputPath,
  execute: executeConvertDocumentToMarkdown,
})

const markitdownTools = {
  'office:convert_document_to_markdown': convertDocumentToMarkdown,
}

export { markitdownTools }
