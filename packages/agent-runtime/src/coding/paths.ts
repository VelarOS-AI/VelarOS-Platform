import { isEmpty } from '@velaros-ai/core'
const CodeVerificationExtensions = new Set([
  '.c',
  '.cc',
  '.cfg',
  '.cjs',
  '.cpp',
  '.cs',
  '.css',
  '.cts',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.lua',
  '.mjs',
  '.mts',
  '.php',
  '.pl',
  '.py',
  '.rb',
  '.rs',
  '.sass',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
])

const CodeVerificationFilenames = new Set([
  '.babelrc',
  '.env',
  '.env.example',
  '.eslintrc',
  '.gitignore',
  '.npmrc',
  '.prettierrc',
  'bun.lock',
  'cargo.lock',
  'dockerfile',
  'gemfile',
  'go.mod',
  'go.sum',
  'makefile',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'procfile',
  'pyproject.toml',
  'rakefile',
  'requirements.txt',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'yarn.lock',
])

function getPortableBasename(path: string): string {
  return [...path.replace(/\\/g, '/').split('/')].reverse().find(Boolean)?.toLowerCase() ?? ''
}

function getExtension(filename: string): string {
  const index = filename.lastIndexOf('.')
  if (index <= 0) return ''

  return filename.slice(index)
}

function isVerificationPath(path: string): boolean {
  const filename = getPortableBasename(path)
  if (!filename) return false

  return (
    CodeVerificationFilenames.has(filename) ||
    CodeVerificationExtensions.has(getExtension(filename))
  )
}

function hasRelevantVerificationPaths(paths: string[]): boolean {
  if (isEmpty(paths)) return true

  return paths.some(isVerificationPath)
}

export { hasRelevantVerificationPaths, isVerificationPath }
export { hasRelevantVerificationPaths as hasVerificationRelevantModifiedPaths }
export { isVerificationPath as isVerificationRelevantPath }
