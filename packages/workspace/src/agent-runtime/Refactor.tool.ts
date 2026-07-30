/**
 * 工作区级重构工具：跨文件搜索替换、符号重命名和文件移动。
 *
 * 所有文件变更都使用工作区内核事务模型：
 * 先在内存中收集全部文件改动，再统一准备编辑并统一应用编辑。
 * 这样整次操作只有一次用户审批和一个回滚点。
 */
import nodePath from 'node:path'

import { z } from 'zod'

import { isEmpty, optionalWhen } from '@velaros-ai/core'
import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'

import { buildWorkspaceMutationSkippedResult, prepareWorkspaceMutation } from './Helpers'
import { escapeRegex, RefactorWorkspaceTransactionCapability, toRelativeImportPath } from './Refactor'
import { defineWorkspaceVelaTool } from './workspaceToolMiddleware'

// ---------------------------------------------------------------------------
// 1. search_replace_in_files
// ---------------------------------------------------------------------------

const searchReplaceInFiles = defineWorkspaceVelaTool<{
  search: string
  replace: string
  glob?: string
  path?: string
  extensions?: string[]
  caseSensitive?: boolean
  regex?: boolean
  wholeWord?: boolean
  dryRun?: boolean
  limit?: number
  cwd?: string
}>({
  name: 'search_replace_in_files',
  role: 'edit',
  category: 'workspace-edit',
  summary: '跨工作区文件批量搜索替换文本。',
  suitable: ['需要重命名常量、接口名、路径前缀等大范围文本重构。'],
  forbidden: ['不要在未预览影响面时执行高风险替换。'],
  protocol: ['先 dryRun=true 预览；确认范围后再写入。'],
  usage: ['传 search 和 replace；用 glob、path 或 extensions 缩小范围。'],
  examples: [
    // 先 dryRun 预览影响面
    { search: 'oldName', replace: 'newName', dryRun: true },
    // 确认后真正写入（dryRun 省略即 false）
    { search: 'oldName', replace: 'newName' },
    // 正则替换 + 捕获组，限定到 .ts/.tsx
    { search: '@old/(\\w+)', replace: '@new/$1', regex: true, extensions: ['ts', 'tsx'] },
    // 整词匹配、限定子目录
    { search: 'config', replace: 'settings', wholeWord: true, path: 'src/core' },
  ],
  notes: ['写入时会作为单个事务提交。'],
  schema: z.object({
    search: z.string().min(1).describe(
      parameterDescription({
        description: '要搜索的文本。',
        notes: ['regex=true 时按正则表达式解释。'],
      })
    ),
    replace: z.string().describe(
      parameterDescription({
        description: '替换文本。',
        notes: ['regex=true 时支持 $1、$2 等捕获组引用。'],
      })
    ),
    glob: z.string().optional().describe(
      parameterDescription({
        description: '文件 glob 过滤。',
        usage: ['例如 **/*.ts 或 src/**/*.tsx。'],
      })
    ),
    path: z.string().optional().describe(
      parameterDescription({
        description: '起始目录。',
        usage: ['传相对工作区根目录的路径。'],
      })
    ),
    extensions: z
      .array(z.string())
      .optional()
      .describe(
        parameterDescription({
          description: '扩展名过滤。',
          usage: ['传不带点号的扩展名，如 ts、tsx。'],
        })
      ),
    caseSensitive: z.boolean().optional().default(false).describe(
      parameterDescription({
        description: '是否区分大小写。',
      })
    ),
    regex: z.boolean().optional().default(false).describe(
      parameterDescription({
        description: '是否把 search 当作正则表达式。',
      })
    ),
    wholeWord: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        parameterDescription({
          description: '是否仅匹配完整标识符。',
          notes: ['开启后会添加单词边界。'],
        })
      ),
    dryRun: z.boolean().optional().default(false).describe(
      parameterDescription({
        description: '是否只预览不写盘。',
      })
    ),
    limit: z.number().int().positive().max(500).optional().default(200).describe(
      parameterDescription({
        description: '最多处理的匹配数量。',
        notes: ['最大 500，默认 200。'],
      })
    ),
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '执行重构的工作目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
  }),
  permissions: ['fs:read', 'fs:write'],
  capabilities: RefactorWorkspaceTransactionCapability,
  async execute(input, ctx) {
    const denied = await prepareWorkspaceMutation(ctx, {
      cwd: input.cwd,
      operation: 'search and replace across files',
      targetPath: input.path,
    })
    if (denied) return buildWorkspaceMutationSkippedResult(denied)

    const runAction = async () => {
      const searchPattern = input.wholeWord ? `\\b${escapeRegex(input.search)}\\b` : input.search
      const matches = await ctx.workspace.searchInFiles({
        query: searchPattern,
        path: input.path,
        glob: input.glob,
        extensions: input.extensions,
        caseSensitive: input.caseSensitive,
        regex: input.regex || input.wholeWord,
        limit: (input.limit ?? 200) * 10,
        maxResultsPerFile: 200,
      })

      if (matches.length === 0) return {
          changed: false,
          matchCount: 0,
          fileCount: 0,
          message: `No matches for: ${input.search}`,
        }

      const byFile = new Map<string, typeof matches>()
      for (const m of matches) {
        const arr = byFile.get(m.path) ?? []
        arr.push(m)
        byFile.set(m.path, arr)
      }

      if (input.dryRun) {
        const preview = Array.from(byFile.entries())
          .slice(0, 20)
          .map(([p, ms]) => ({
            path: p,
            matchCount: ms.length,
            samples: ms.slice(0, 3).map((m) => `  L${m.line}: ${m.excerpt.trim()}`),
          }))
        return {
          changed: false,
          dryRun: true,
          matchCount: matches.length,
          fileCount: byFile.size,
          preview,
        }
      }

      const searchRegex = new RegExp(
        input.wholeWord
          ? `\\b${escapeRegex(input.search)}\\b`
          : input.regex
            ? input.search
            : escapeRegex(input.search),
        `${input.caseSensitive ? '' : 'i'}g`
      )

      // Collect all replacements in memory
      const operations: Array<{
        operation: { type: 'replace_text'; path: string; oldText: string; newText: string }
      }> = []
      const skipped: string[] = []
      let totalReplacements = 0

      const kernel = await ctx.workspace.kernel()
      for (const [filePath] of byFile) {
        const readResult = await kernel.read({ path: filePath })
        const before = readResult.content ?? ''
        if (!before || readResult.snapshot.isBinary) {
          skipped.push(`${filePath}: not readable, skipped`)
          continue
        }
        const after = before.replace(searchRegex, input.replace)
        if (before !== after) {
          const count = (before.match(searchRegex) ?? []).length
          totalReplacements += count
          // Using replace_text with the full oldText gives implicit revision protection:
          // if another session modified the file between our read and this write,
          // prepareEdit will throw because oldText won't match.
          operations.push({
            operation: { type: 'replace_text', path: filePath, oldText: before, newText: after },
          })
        }
      }

      if (isEmpty(operations)) return {
          changed: false,
          matchCount: matches.length,
          fileCount: 0,
          message: 'No files changed after replacement',
        }

      const tx = await kernel.prepareEdit({ operations })
      const result = await ctx.workspace.runWithApproval(
        () => kernel.applyEdit({ transactionId: tx.transactionId })
      )

      return {
        changed: true,
        changedFiles: result.changedFiles.length,
        totalReplacements,
        changedPaths: result.changedFiles.slice(0, 30),
        transactionId: result.transactionId,
        skipped: optionalWhen((!isEmpty(skipped)), skipped),
        message: `Replaced in ${result.changedFiles.length} files (${totalReplacements} replacements)`,
      }
    }

    return input.cwd ? ctx.workspace.runInDirectory(input.cwd, runAction) : runAction()
  },
})

// ---------------------------------------------------------------------------
// 2. rename_symbol
// ---------------------------------------------------------------------------

const renameSymbol = defineWorkspaceVelaTool<{
  oldName: string
  newName: string
  extensions?: string[]
  path?: string
  includeComments?: boolean
  includeStrings?: boolean
  dryRun?: boolean
  cwd?: string
}>({
  name: 'rename_symbol',
  role: 'edit',
  category: 'workspace-edit',
  summary: '跨项目重命名符号。',
  suitable: ['需要重命名变量、函数、类、接口或常量。'],
  forbidden: ['不要用它重命名非标识符文本或文件路径。'],
  protocol: ['先 dryRun=true 查看影响范围；确认后再提交。'],
  usage: ['传 oldName 和 newName；可用 path 或 extensions 限定范围。'],
  examples: [
    // 先 dryRun 看影响范围
    { oldName: 'Foo', newName: 'Bar', dryRun: true },
    // 确认后提交
    { oldName: 'Foo', newName: 'Bar' },
    // 限定到某目录，并连字符串字面量里的一起改
    { oldName: 'legacyFlag', newName: 'nextFlag', path: 'src/config', includeStrings: true },
  ],
  notes: ['使用标识符边界匹配，并作为单个事务提交。'],
  schema: z.object({
    oldName: z.string().min(1).describe(
      parameterDescription({
        description: '当前符号名。',
        notes: ['必须是合法 JS/TS 标识符。'],
      })
    ),
    newName: z.string().min(1).describe(
      parameterDescription({
        description: '新的符号名。',
        notes: ['必须是合法 JS/TS 标识符。'],
      })
    ),
    extensions: z
      .array(z.string())
      .optional()
      .default(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'])
      .describe(
        parameterDescription({
          description: '扩展名过滤。',
          usage: ['传不带点号的扩展名。'],
        })
      ),
    path: z.string().optional().describe(
      parameterDescription({
        description: '重命名范围目录。',
        usage: ['传相对工作区根目录的路径。'],
      })
    ),
    includeComments: z.boolean().optional().default(true).describe(
      parameterDescription({
        description: '是否包含注释中的命中。',
      })
    ),
    includeStrings: z.boolean().optional().default(false).describe(
      parameterDescription({
        description: '是否包含字符串字面量中的命中。',
      })
    ),
    dryRun: z.boolean().optional().default(false).describe(
      parameterDescription({
        description: '是否只预览不写盘。',
      })
    ),
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '执行重命名的工作目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
  }),
  permissions: ['fs:read', 'fs:write'],
  capabilities: RefactorWorkspaceTransactionCapability,
  async execute(input, ctx) {
    if (!/^[$_a-zA-Z][$_a-zA-Z0-9]*$/.test(input.oldName))
      return { error: `"${input.oldName}" is not a valid JS/TS identifier` }
    if (!/^[$_a-zA-Z][$_a-zA-Z0-9]*$/.test(input.newName))
      return { error: `"${input.newName}" is not a valid JS/TS identifier` }

    const denied = await prepareWorkspaceMutation(ctx, {
      cwd: input.cwd,
      operation: 'rename symbol across project',
      targetPath: input.path,
    })
    if (denied) return buildWorkspaceMutationSkippedResult(denied)

    const runAction = async () => {
      const matches = await ctx.workspace.searchInFiles({
        query: `\\b${escapeRegex(input.oldName)}\\b`,
        path: input.path,
        extensions: input.extensions ?? ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'],
        regex: true,
        caseSensitive: true,
        limit: 5000,
        maxResultsPerFile: 500,
      })

      if (matches.length === 0) return {
          changed: false,
          matchCount: 0,
          fileCount: 0,
          message: `Symbol "${input.oldName}" not found`,
        }

      const byFile = new Map<string, typeof matches>()
      for (const m of matches) {
        const arr = byFile.get(m.path) ?? []
        arr.push(m)
        byFile.set(m.path, arr)
      }

      if (input.dryRun) {
        const preview = Array.from(byFile.entries())
          .slice(0, 20)
          .map(([p, ms]) => ({
            path: p,
            matchCount: ms.length,
            samples: ms.slice(0, 3).map((m) => `  L${m.line}: ${m.excerpt.trim()}`),
          }))
        return {
          changed: false,
          dryRun: true,
          matchCount: matches.length,
          fileCount: byFile.size,
          preview,
        }
      }

      const wordBoundaryRegex = new RegExp(`\\b${escapeRegex(input.oldName)}\\b`, 'g')
      const operations: Array<{
        operation: { type: 'replace_text'; path: string; oldText: string; newText: string }
      }> = []
      const skipped: string[] = []
      let totalReplacements = 0

      const kernel = await ctx.workspace.kernel()
      for (const [filePath] of byFile) {
        const readResult = await kernel.read({ path: filePath })
        const before = readResult.content ?? ''
        if (!before || readResult.snapshot.isBinary) {
          skipped.push(`${filePath}: too large, skipped`)
          continue
        }
        const count = (before.match(wordBoundaryRegex) ?? []).length
        const after = before.replace(wordBoundaryRegex, input.newName)
        if (before !== after) {
          totalReplacements += count
          operations.push({
            operation: { type: 'replace_text', path: filePath, oldText: before, newText: after },
          })
        }
      }

      if (isEmpty(operations)) return {
          changed: false,
          matchCount: matches.length,
          fileCount: 0,
          message: 'No files changed',
        }

      const tx = await kernel.prepareEdit({ operations })
      const result = await ctx.workspace.runWithApproval(
        () => kernel.applyEdit({ transactionId: tx.transactionId })
      )

      return {
        changed: true,
        changedFiles: result.changedFiles.length,
        totalReplacements,
        changedFileList: result.changedFiles.slice(0, 30),
        transactionId: result.transactionId,
        skipped: optionalWhen((!isEmpty(skipped)), skipped),
        message: `Renamed "${input.oldName}" → "${input.newName}" in ${result.changedFiles.length} files (${totalReplacements} occurrences)`,
      }
    }

    return input.cwd ? ctx.workspace.runInDirectory(input.cwd, runAction) : runAction()
  },
})

// ---------------------------------------------------------------------------
// 3. move_file
// ---------------------------------------------------------------------------

const moveFileUpdateImports = defineWorkspaceVelaTool<{
  fromPath: string
  toPath: string
  updateImports?: boolean
  dryRun?: boolean
  cwd?: string
}>({
  // 内部契约名必须与注册名一致(examples registry 键脱节问题,同 ws_run_command)。
  name: 'move_file',
  role: 'edit',
  category: 'workspace-edit',
  summary: '移动或重命名文件并更新引用路径。',
  suitable: ['需要搬移文件，同时修正 import 或 require 路径。'],
  forbidden: ['不要用它做目录级大迁移。'],
  protocol: ['先 dryRun=true 预览影响；确认后再提交。'],
  usage: ['传 fromPath 和 toPath；默认 updateImports=true。'],
  examples: [
    // 先 dryRun 预览会改哪些引用
    { fromPath: 'src/a.ts', toPath: 'src/core/a.ts', dryRun: true },
    // 移动并自动改 import（默认）
    { fromPath: 'src/a.ts', toPath: 'src/core/a.ts' },
    // 原地改名
    { fromPath: 'src/oldName.ts', toPath: 'src/newName.ts' },
    // 只移动、不动引用路径
    { fromPath: 'src/a.ts', toPath: 'src/core/a.ts', updateImports: false },
  ],
  notes: ['文件移动和引用更新会作为单个事务提交。'],
  schema: z.object({
    fromPath: z.string().min(1).describe(
      parameterDescription({
        description: '当前文件路径。',
        usage: ['传相对工作区根目录的路径。'],
      })
    ),
    toPath: z.string().min(1).describe(
      parameterDescription({
        description: '目标文件路径。',
        usage: ['传相对工作区根目录的路径。'],
      })
    ),
    updateImports: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        parameterDescription({
          description: '是否自动更新导入路径。',
          notes: ['默认 true。'],
        })
      ),
    dryRun: z.boolean().optional().default(false).describe(
      parameterDescription({
        description: '是否只预览不写盘。',
      })
    ),
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '执行移动的工作目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
  }),
  permissions: ['fs:read', 'fs:write'],
  capabilities: RefactorWorkspaceTransactionCapability,
  async execute(input, ctx) {
    const denied = await prepareWorkspaceMutation(ctx, {
      cwd: input.cwd,
      operation: 'move file and update imports',
      targetPath: input.fromPath,
    })
    if (denied) return buildWorkspaceMutationSkippedResult(denied)

    const runAction = async () => {
      const rootPath = ctx.workspace.getRootPath()
      const fromAbs = nodePath.resolve(rootPath, input.fromPath)
      const toAbs = nodePath.resolve(rootPath, input.toPath)
      const fromBareName = nodePath.basename(input.fromPath).replace(/\.[^.]+$/, '')

      const importMatches = await ctx.workspace.searchInFiles({
        query: escapeRegex(fromBareName),
        extensions: ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'],
        regex: false,
        caseSensitive: true,
        limit: 2000,
        maxResultsPerFile: 100,
      })

      const importPattern = /(?:import|require|from)\s*['"`]([^'"`]+)['"`]/
      const relevantMatches = importMatches.filter((m) => {
        if (m.path === input.fromPath) return false
        if (!importPattern.test(m.excerpt)) return false
        const match = m.excerpt.match(/['"`]([^'"`]+)['"`]/)
        if (!match) return false
        const ip = match[1]
        return (
          ip.endsWith(`/${fromBareName}`) ||
          ip.endsWith(`/${nodePath.basename(input.fromPath)}`) ||
          ip === fromBareName ||
          ip === `./${fromBareName}`
        )
      })

      const byFile = new Map<string, typeof relevantMatches>()
      for (const m of relevantMatches) {
        const arr = byFile.get(m.path) ?? []
        arr.push(m)
        byFile.set(m.path, arr)
      }

      if (input.dryRun) return {
          changed: false,
          dryRun: true,
          fromPath: input.fromPath,
          toPath: input.toPath,
          affectedImporters: byFile.size,
          preview: Array.from(byFile.entries())
            .slice(0, 20)
            .map(([p, ms]) => ({
              path: p,
              lines: ms.map((m) => `  L${m.line}: ${m.excerpt.trim()}`),
            })),
        }

      // Build all operations: import updates + rename_file
      const operations: Array<{ operation: Record<string, any> }> = []
      const skipped: string[] = []
      const kernel = await ctx.workspace.kernel()

      if (input.updateImports ?? true) {
        for (const [filePath] of byFile) {
          const readResult = await kernel.read({ path: filePath })
          const originalContent = readResult.content ?? ''
          if (!originalContent || readResult.snapshot.isBinary) {
            skipped.push(`${filePath}: too large, skipped`)
            continue
          }

          const importerDir = nodePath.dirname(nodePath.resolve(rootPath, filePath))
          const oldRel = toRelativeImportPath(fromAbs, importerDir)
          const newRel = toRelativeImportPath(toAbs, importerDir)
          const oldBare = oldRel.replace(/\.[^.]+$/, '')
          const newBare = newRel.replace(/\.[^.]+$/, '')

          let updatedContent = originalContent
          for (const [oldP, newP] of [
            [oldRel, newRel],
            [oldBare, newBare],
          ] as Array<[string, string]>) {
            const regex = new RegExp(`(['"\`])${escapeRegex(oldP)}(['"\`])`, 'g')
            updatedContent = updatedContent.replace(regex, `$1${newP}$2`)
          }

          if (updatedContent !== originalContent) {
            // replace_text with full file content for implicit revision protection
            operations.push({
              operation: {
                type: 'replace_text',
                path: filePath,
                oldText: originalContent,
                newText: updatedContent,
              },
            })
          }
        }
      }

      // Add the file rename as the last operation
      operations.push({
        operation: { type: 'rename_file', from: input.fromPath, to: input.toPath },
      })

      const tx = await kernel.prepareEdit({ operations } as Parameters<typeof kernel.prepareEdit>[0])
      const result = await ctx.workspace.runWithApproval(
        () => kernel.applyEdit({ transactionId: tx.transactionId })
      )

      return {
        changed: true,
        fromPath: input.fromPath,
        toPath: input.toPath,
        updatedImporters: result.changedFiles.filter((f) => f !== input.toPath),
        transactionId: result.transactionId,
        skipped: optionalWhen((!isEmpty(skipped)), skipped),
        message: `Moved "${input.fromPath}" → "${input.toPath}", updated ${result.changedFiles.length - 1} importer(s)`,
      }
    }

    return input.cwd ? ctx.workspace.runInDirectory(input.cwd, runAction) : runAction()
  },
})

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const ideRefactorTools = {
  search_replace_in_files: searchReplaceInFiles,
  rename_symbol: renameSymbol,
  move_file: moveFileUpdateImports,
}
export { ideRefactorTools }
