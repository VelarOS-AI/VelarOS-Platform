/** 按扩展名推导文件图标/语义分类，供列表与预览使用。 */
export type FilePresentationKind =
  | 'archive'
  | 'audio'
  | 'code'
  | 'csv'
  | 'document'
  | 'html'
  | 'image'
  | 'markdown'
  | 'pdf'
  | 'presentation'
  | 'spreadsheet'
  | 'text'
  | 'video'
  | 'generic'

/** 语言/扩展名级展示键，用于文件树、标签页等更细粒度的图标与配色。 */
export type FilePresentationVariant =
  | FilePresentationKind
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'go'
  | 'java'
  | 'javascript'
  | 'json'
  | 'jsx'
  | 'lua'
  | 'php'
  | 'python'
  | 'rust'
  | 'scss'
  | 'shell'
  | 'sql'
  | 'swift'
  | 'toml'
  | 'tsx'
  | 'typescript'
  | 'velarscript'
  | 'vue'
  | 'xml'
  | 'yaml'

const ArchiveExtensions = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip'])
const AudioExtensions = new Set(['aac', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav'])
const CodeExtensions = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'go',
  'java',
  'json',
  'jsx',
  'lua',
  'mjs',
  'php',
  'py',
  'rs',
  'scss',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'vue',
  'vel',
  'xml',
  'yaml',
  'yml',
])
const DocumentExtensions = new Set(['doc', 'docx', 'odt', 'rtf'])
const HtmlExtensions = new Set(['htm', 'html'])
const ImageExtensions = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const MarkdownExtensions = new Set(['markdown', 'md', 'mdx'])
const PresentationExtensions = new Set(['key', 'odp', 'ppt', 'pptx'])
const SpreadsheetExtensions = new Set(['numbers', 'ods', 'xls', 'xlsx'])
const TextExtensions = new Set(['env', 'ini', 'log', 'text', 'txt'])
const VideoExtensions = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'wmv'])

const FILE_PRESENTATION_VARIANT_COLORS: Record<FilePresentationVariant, string> = {
  archive: '#a16207',
  audio: '#c2410c',
  c: '#555555',
  code: '#6e7681',
  cpp: '#f34b7d',
  csharp: '#178600',
  css: '#cc6699',
  csv: '#15803d',
  document: '#2563eb',
  generic: '#2563eb',
  go: '#00add8',
  html: '#e44d26',
  image: '#0f766e',
  java: '#b07219',
  javascript: '#c9b134',
  json: '#cbaf31',
  jsx: '#61dafb',
  lua: '#000080',
  markdown: '#519aba',
  pdf: '#dc2626',
  php: '#4f5d95',
  presentation: '#d97706',
  python: '#3572a5',
  rust: '#dea584',
  scss: '#cc6699',
  shell: '#89e051',
  spreadsheet: '#15803d',
  sql: '#e38c00',
  swift: '#f05138',
  text: '#2563eb',
  toml: '#9c4221',
  tsx: '#3178c6',
  typescript: '#3178c6',
  velarscript: 'currentColor',
  video: '#c026d3',
  vue: '#42b883',
  xml: '#e37933',
  yaml: '#cb171e',
}

function splitPathSegments(pathText: string): string[] {
  return pathText.split(/[/\\]/u)
}

export function getFileExtension(fileName: string): string {
  const pathSegments = splitPathSegments(fileName)
  const normalizedName = pathSegments[pathSegments.length - 1] ?? ''
  const dotIndex = normalizedName.lastIndexOf('.')

  if (dotIndex <= 0 || dotIndex === normalizedName.length - 1) return ''

  return normalizedName.slice(dotIndex + 1).toLowerCase()
}

function getFilePresentationVariantFromExtension(extension: string): FilePresentationVariant | null {
  switch (extension) {
    case 'ts':
      return 'typescript'
    case 'vel':
      return 'velarscript'
    case 'tsx':
      return 'tsx'
    case 'js':
    case 'mjs':
      return 'javascript'
    case 'jsx':
      return 'jsx'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'html':
    case 'htm':
      return 'html'
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'toml':
      return 'toml'
    case 'xml':
      return 'xml'
    case 'py':
      return 'python'
    case 'rs':
      return 'rust'
    case 'go':
      return 'go'
    case 'java':
      return 'java'
    case 'cs':
      return 'csharp'
    case 'cpp':
    case 'cc':
      return 'cpp'
    case 'c':
      return 'c'
    case 'php':
      return 'php'
    case 'lua':
      return 'lua'
    case 'sh':
      return 'shell'
    case 'swift':
      return 'swift'
    case 'vue':
      return 'vue'
    case 'sql':
      return 'sql'
    default:
      return null
  }
}

export function getFilePresentationKind(input: {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}): FilePresentationKind {
  const mediaType = input.mediaType?.trim().toLowerCase() ?? ''
  const extension = getFileExtension(input.fileName ?? '')

  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType.startsWith('video/')) return 'video'
  if (mediaType.startsWith('audio/')) return 'audio'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType.includes('spreadsheet') || mediaType.includes('excel')) return 'spreadsheet'
  if (mediaType.includes('presentation') || mediaType.includes('powerpoint')) return 'presentation'
  if (mediaType.includes('wordprocessing') || mediaType.includes('msword')) return 'document'

  if (!extension) return 'generic'
  if (ImageExtensions.has(extension)) return 'image'
  if (VideoExtensions.has(extension)) return 'video'
  if (AudioExtensions.has(extension)) return 'audio'
  if (ArchiveExtensions.has(extension)) return 'archive'
  if (extension === 'pdf') return 'pdf'
  if (SpreadsheetExtensions.has(extension) || extension === 'csv') return extension === 'csv' ? 'csv' : 'spreadsheet'
  if (PresentationExtensions.has(extension)) return 'presentation'
  if (DocumentExtensions.has(extension)) return 'document'
  if (MarkdownExtensions.has(extension)) return 'markdown'
  if (HtmlExtensions.has(extension)) return 'html'
  if (TextExtensions.has(extension)) return 'text'
  if (CodeExtensions.has(extension) || mediaType.includes('json') || mediaType.includes('xml')) return 'code'

  return 'generic'
}

export function getFilePresentationVariant(input: {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}): FilePresentationVariant {
  const mediaType = input.mediaType?.trim().toLowerCase() ?? ''
  const extension = getFileExtension(input.fileName ?? '')

  const variantFromExtension = getFilePresentationVariantFromExtension(extension)
  if (variantFromExtension) return variantFromExtension

  if (mediaType.includes('json')) return 'json'
  if (mediaType.includes('spreadsheet') || mediaType.includes('excel')) return 'spreadsheet'
  if (mediaType.includes('presentation') || mediaType.includes('powerpoint')) return 'presentation'
  if (mediaType.includes('wordprocessing') || mediaType.includes('msword')) return 'document'
  if (mediaType.includes('xml')) return 'xml'

  const kind = getFilePresentationKind(input)
  if (kind === 'code') return 'code'

  return kind
}

export function getFilePresentationColor(input: {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}): string {
  return FILE_PRESENTATION_VARIANT_COLORS[getFilePresentationVariant(input)]
}
