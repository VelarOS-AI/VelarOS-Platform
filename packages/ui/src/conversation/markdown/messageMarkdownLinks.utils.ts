import { isBlank } from '#internal/runtime'
export type MessageMarkdownHrefTarget =
  | { kind: 'web'; url: string }
  | { kind: 'external-protocol'; url: string }
  | { kind: 'project-file'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'passthrough'; href: string }

const WebLinkPattern = /^https?:\/\//i
const ExternalNonWebLinkPattern = /^(mailto:|tel:)/i
const FileUrlPattern = /^file:\/\//i
const VersionLikePattern = /^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/u
const KnownFileReferenceExtensionSet = new Set([
  'bash',
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'csv',
  'cts',
  'd',
  'dart',
  'diff',
  'doc',
  'docx',
  'env',
  'gif',
  'go',
  'graphql',
  'h',
  'hpp',
  'htm',
  'html',
  'ico',
  'ini',
  'java',
  'jpeg',
  'jpg',
  'js',
  'json',
  'jsx',
  'kt',
  'less',
  'lock',
  'log',
  'lua',
  'm',
  'md',
  'mdx',
  'mjs',
  'mm',
  'mts',
  'pdf',
  'php',
  'plist',
  'png',
  'proto',
  'py',
  'rb',
  'rs',
  'sass',
  'scss',
  'sh',
  'sql',
  'svg',
  'swift',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'vue',
  'webp',
  'xml',
  'yaml',
  'yml',
  'zsh',
])
const FileReferenceCandidatePattern =
  /^(?!.*\s)(?!.*(?:&&|\|\||[;<>`]))(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/]{1,2})?[\w@.+~-]+(?:[\\/][\w@.+~-]+)*\.[A-Za-z0-9][A-Za-z0-9.-]{0,15}(?::\d+(?::\d+)?)?$/u
const AbsoluteFileReferencePattern = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u

function stripFileReferenceLocation(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/u, '')
}

function hasKnownFileReferenceExtension(value: string): boolean {
  const fileName = stripFileReferenceLocation(value).split(/[\\/]/u).pop() ?? ''
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''

  return KnownFileReferenceExtensionSet.has(extension.toLowerCase())
}

function normalizeFileUrlPath(href: string): Nullable<string> {
  if (!FileUrlPattern.test(href)) return null

  return URL.canParse(href) ? new URL(href).pathname : href.replace(FileUrlPattern, '')
}

function isMessageMarkdownFileReferenceCandidate(value: string): boolean {
  const trimmed = value.trim()
  if (
    isBlank(trimmed) ||
    WebLinkPattern.test(trimmed) ||
    ExternalNonWebLinkPattern.test(trimmed) ||
    VersionLikePattern.test(stripFileReferenceLocation(trimmed)) ||
    /[(){}[\]]/u.test(trimmed) ||
    /(?:^|\s)(?:cd|node|npm|npx|pnpm|yarn|bun|python|python3|sh|bash|zsh|git)\s/u.test(trimmed)
  ) return false

  return FileReferenceCandidatePattern.test(trimmed) && hasKnownFileReferenceExtension(trimmed)
}

export function isMessageMarkdownFileReference(value: string): boolean {
  const trimmed = value.trim()

  return (
    AbsoluteFileReferencePattern.test(trimmed) && isMessageMarkdownFileReferenceCandidate(trimmed)
  )
}

export function normalizeMessageMarkdownFileReference(value: string): Nullable<string> {
  const trimmed = value.trim()
  const fileUrlPath = normalizeFileUrlPath(trimmed)
  if (fileUrlPath) return stripFileReferenceLocation(fileUrlPath)

  if (!isMessageMarkdownFileReference(trimmed)) return null

  return stripFileReferenceLocation(trimmed)
}

export function resolveMessageMarkdownHrefTarget(href: string): MessageMarkdownHrefTarget {
  const link = href.trim()
  if (WebLinkPattern.test(link)) return { kind: 'web', url: link }

  if (ExternalNonWebLinkPattern.test(link)) return { kind: 'external-protocol', url: link }

  const filePath = normalizeMessageMarkdownFileReference(link)
  if (filePath) return { kind: 'project-file', path: filePath }

  if (isMessageMarkdownFileReferenceCandidate(link)) return { kind: 'text', text: link }

  return { kind: 'passthrough', href }
}
