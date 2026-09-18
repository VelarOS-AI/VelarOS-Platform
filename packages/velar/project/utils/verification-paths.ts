/**
 * 「什么算代码文件」这条判据：改到哪些文件之后值得再跑一次验证命令（构建、测试、lint）。
 * 名单是规则本身的数据，跟着规则留在这里——加一种语言、加一个构建清单，和判定一起审。
 */

/** 源码与配置格式的扩展名：改到它们就可能改变构建结果。 */
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

/** 构建、依赖与配置清单的文件名（全名认，没有扩展名可认）：改到它们同样要重新验证。 */
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

/**
 * 取路径的文件名部分并转小写：Windows 反斜杠先归一成 `/`，再取最后一个非空段
 * （所以尾随斜杠不会取到空串）。整条路径全是分隔符时返回 `''`。
 * 转小写是为了让上面两张白名单只写一种大小写就能命中 macOS/Windows 上的大小写变体。
 */
function portableBasename(path: string): string {
  return [...path.replace(/\\/g, '/').split('/')].reverse().find(Boolean)?.toLowerCase() ?? ''
}

/**
 * 取文件名的扩展名（含前导 `.`，如 `.ts`）。没有 `.` 返回 `''`；
 * `.` 落在首位（`.env`、`.gitignore` 这类点开头文件）也返回 `''`——它们整体是文件名不是扩展名，
 * 由 CodeVerificationFilenames 那张表按全名认。
 */
function fileExtension(filename: string): string {
  const index = filename.lastIndexOf('.')
  if (index <= 0) return ''

  return filename.slice(index)
}

/**
 * 判断这个路径的改动值不值得再跑一次验证命令：文件名命中 CodeVerificationFilenames
 * （构建/依赖/配置清单）或扩展名命中 CodeVerificationExtensions（源码与配置格式）时为真。
 * 图片、文档、日志等不影响构建结果的改动为假，用来避免为纯资源改动重复催验证。
 */
export function isVerificationRelevantProjectPath(path: string): boolean {
  const filename = portableBasename(path)
  if (!filename) return false

  return (
    CodeVerificationFilenames.has(filename) ||
    CodeVerificationExtensions.has(fileExtension(filename))
  )
}
