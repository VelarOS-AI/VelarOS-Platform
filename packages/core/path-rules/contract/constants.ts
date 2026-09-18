/**
 * 常量表：遍历与搜索默认跳过的目录名。不 import 任何东西，浏览器和渲染进程都能用（从 `@velaros-ai/core/path-rules/contracts` 取）。
 */

/**
 * 遍历与搜索默认跳过的目录名：版本库、依赖、虚拟环境、构建产物、缓存与编辑器配置。
 * 这是「按名字一刀切」的那一层，跟 .gitignore 无关——没有版本库、或者仓库根本没写忽略规则的目录树也照跳。
 */
export const DiscoverySkippedDirectoryNames: readonly string[] = Object.freeze([
  '.codegraph',
  '.git',
  '.hg',
  '.jj',
  '.svn',
  'node_modules',
  'vendor',
  '.venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.data',
  'dist',
  'build',
  'out',
  'coverage',
  '.idea',
  '.vscode',
  'Library',
])
