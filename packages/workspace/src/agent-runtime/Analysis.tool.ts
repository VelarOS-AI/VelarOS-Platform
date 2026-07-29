/**
 * 代码分析工具集：死代码检测、依赖分析、导出覆盖率检查。
 *
 * 这些工具帮助模型在重构前快速定位可安全删除的代码，
 * 减少"改了一个文件却不知道影响哪里"的盲目操作。
 */
import { z } from 'zod'

import { isEmpty, isTrue, Log } from '@velaros-ai/core'
import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'

import { defineWorkspaceVelaTool } from './workspaceToolMiddleware'

// ---------------------------------------------------------------------------
// find_unused_exports — 查找没有 importer 的导出（死代码预警）
// ---------------------------------------------------------------------------

const findUnusedExports = defineWorkspaceVelaTool<{
  path?: string
  extensions?: string[]
  excludeIndexFiles?: boolean
  excludePatterns?: string[]
  cwd?: string
}>({
  name: 'find_unused_exports',
  role: 'inspect',
  category: 'workspace-inspect',
  summary: '查找工作区内疑似未使用的导出符号。',
  suitable: ['重构前需要初步定位可能可删除的导出。'],
  forbidden: ['不要把结果当作删除许可；入口文件、动态引用和反射可能误报。'],
  usage: ['可传 path、extensions、excludeIndexFiles、excludePatterns、cwd。'],
  examples: [{ path: "src", extensions: ["ts", "tsx"] }],
  notes: ['删除前仍需人工或测试确认。'],
  permissions: ['fs:read'],
  schema: z.object({
    path: z.string().optional().describe(
      parameterDescription({
        description: '限定扫描目录。',
        usage: ['传相对工作区根目录的路径。'],
        notes: ['省略时扫描整个工作区。'],
      })
    ),
    extensions: z
      .array(z.string())
      .optional()
      .default(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'])
      .describe(
        parameterDescription({
          description: '文件扩展名过滤。',
          usage: ['传不带点号的扩展名，如 ts、tsx。'],
          notes: ['默认扫描常见 JS/TS 文件。'],
        })
      ),
    excludeIndexFiles: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        parameterDescription({
          description: '是否排除 index.ts/index.tsx。',
          notes: ['公共导出聚合文件容易造成误报，默认排除。'],
        })
      ),
    excludePatterns: z
      .array(z.string())
      .optional()
      .default([])
      .describe(
        parameterDescription({
          description: '路径片段排除列表。',
          usage: ['命中任一片段的文件会被跳过，如 stories、test、spec、mock。'],
        })
      ),
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '执行分析的工作目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
  }),
  async execute(input, ctx) {
    const runAction = async () => {
      const kernel = await ctx.workspace.kernel()
      const defaultExclude = input.excludePatterns ?? []

      const shouldExclude = (filePath: string): boolean => {
        if (input.excludeIndexFiles) {
          const base = filePath.split('/').pop() ?? ''
          if (base === 'index.ts' || base === 'index.tsx') return true
        }
        return defaultExclude.some((p) => filePath.includes(p))
      }

      // 1. 列出全部代码文件，并通过内核提取导出符号。
      const ext = input.extensions ?? ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']
      const files = await kernel.listFiles({
        path: input.path,
        recursive: true,
        maxDepth: 12,
        maxFiles: 2000,
      })
      const codeFiles = files.filter(
        (f) =>
          f.type === 'file' && ext.some((e) => f.path.endsWith(`.${e}`)) && !shouldExclude(f.path)
      )

      type ExportedSymbol = { name: string; kind: string; path: string; line: number }
      const allExports: ExportedSymbol[] = []
      for (const file of codeFiles) {
        const symbols = await kernel.listSymbols(file.path)
        for (const sym of symbols as Array<{
          name: string
          kind?: string
          exported?: boolean
          line?: number
          range?: { startLine?: number }
          metadata?: Record<string, any>
        }>) {
          if (sym.exported || isTrue(sym.metadata?.exported)) {
            allExports.push({
              name: sym.name,
              kind: sym.kind ?? 'unknown',
              path: file.path,
              line: sym.range?.startLine ?? sym.line ?? 0,
            })
          }
        }
      }

      if (isEmpty(allExports)) return { unusedCount: 0, unused: [], scannedExports: 0, message: '未找到任何导出符号' }

      // 2. For each exported symbol, check if it's referenced anywhere outside its own file
      const unused: ExportedSymbol[] = []
      const CONCURRENCY = 20
      for (let i = 0; i < allExports.length; i += CONCURRENCY) {
        const batch = allExports.slice(i, i + CONCURRENCY)
        const results = await Promise.all(
          batch.map(async (sym) => {
            try {
              const searchResult = await kernel.search({ query: sym.name, maxResults: 10 })
              const externalRefs = searchResult.hits.filter((h) => h.path !== sym.path)
              return isEmpty(externalRefs) ? sym : null
            } catch (error) {
              Log.tag('WorkspaceAnalysisTools').debug('搜索导出符号引用失败，跳过该符号', {
                symbol: sym.name,
                path: sym.path,
                error: String(error),
              })
              return null
            }
          })
        )
        for (const sym of results) {
          if (sym) unused.push(sym)
        }
      }

      return {
        unusedCount: unused.length,
        scannedExports: allExports.length,
        unused: unused.slice(0, 200),
        message: isEmpty(unused)
          ? `已扫描 ${allExports.length} 个导出，未发现疑似死代码`
          : `已扫描 ${allExports.length} 个导出，发现 ${unused.length} 个疑似未使用的导出（前 ${Math.min(unused.length, 200)} 条）`,
        tip: '建议手动确认后再删除；入口文件、动态引用和反射场景可能有误报',
      }
    }

    return input.cwd ? ctx.workspace.runInDirectory(input.cwd, runAction) : runAction()
  },
})

// ---------------------------------------------------------------------------
// read_symbol — 按符号名精确读取函数/类/变量代码块（不需要知道行号）
// ---------------------------------------------------------------------------

const readSymbol = defineWorkspaceVelaTool<{
  path: string
  symbol: string
  context?: number
  cwd?: string
}>({
  name: 'read_symbol',
  role: 'inspect',
  category: 'workspace-inspect',
  summary: '按符号名读取对应代码块。',
  suitable: ['知道函数、类或变量名，但不知道行号。'],
  forbidden: ['不要用它做跨文件引用分析。'],
  usage: ['传 path 和 symbol；可传 context 增加前后文。'],
  examples: [{ path: "src/app.ts", symbol: "buildPlan", context: 3 }],
  notes: ['返回 startLine、endLine 和 content。'],
  permissions: ['fs:read'],
  schema: z.object({
    path: z.string().min(1).describe(
      parameterDescription({
        description: '目标文件路径。',
        usage: ['传相对工作区根目录的路径。'],
      })
    ),
    symbol: z
      .string()
      .min(1)
      .describe(
        parameterDescription({
          description: '要查找的符号名。',
          usage: ['传函数名、类名、变量名或接口名。'],
        })
      ),
    context: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .default(0)
      .describe(
        parameterDescription({
          description: '符号前后额外展示的上下文行数。',
          notes: ['默认 0，最大 20。'],
        })
      ),
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '执行读取的工作目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
  }),
  async execute(input, ctx) {
    const runAction = async () => {
      const kernel = await ctx.workspace.kernel()

      // 1. Use kernel's symbol index (TypeScript adapter) to find the symbol
      const symbols = (await kernel.listSymbols(input.path)) as Array<{
        name: string
        kind?: string
        range?: { startLine?: number; endLine?: number }
        line?: number
      }>

      const match =
        symbols.find((s) => s.name === input.symbol) ??
        symbols.find((s) => s.name.toLowerCase() === input.symbol.toLowerCase())

      if (!match) {
        // Fallback: resolve via target API which uses all registered adapters
        const resolved = await kernel.resolveTarget({
          path: input.path,
          target: { symbol: { name: input.symbol } },
        })
        if (resolved.status !== 'resolved') return {
            error: `在 "${input.path}" 中未找到符号 "${input.symbol}"。可先列出该文件的符号索引再核对名称。`,
          }
        const startLine = resolved.target.range?.startLine ?? 1
        const endLine = resolved.target.range?.endLine ?? startLine
        const ctx2 = input.context ?? 0
        const result = await kernel.read({
          path: input.path,
          range: { startLine: Math.max(1, startLine - ctx2), endLine: endLine + ctx2 },
        })
        return {
          path: input.path,
          symbol: input.symbol,
          startLine: Math.max(1, startLine - ctx2),
          endLine: endLine + ctx2,
          symbolStartLine: startLine,
          symbolEndLine: endLine,
          content: result.content ?? '',
          totalLines: endLine + ctx2 - Math.max(1, startLine - ctx2) + 1,
        }
      }

      // 2. Read the symbol's line range from the kernel
      const startLine = match.range?.startLine ?? match.line ?? 1
      const endLine = match.range?.endLine ?? startLine
      const ctx2 = input.context ?? 0
      const result = await kernel.read({
        path: input.path,
        range: { startLine: Math.max(1, startLine - ctx2), endLine: endLine + ctx2 },
      })

      return {
        path: input.path,
        symbol: input.symbol,
        kind: match.kind,
        startLine: Math.max(1, startLine - ctx2),
        endLine: endLine + ctx2,
        symbolStartLine: startLine,
        symbolEndLine: endLine,
        content: result.content ?? '',
        totalLines: endLine + ctx2 - Math.max(1, startLine - ctx2) + 1,
      }
    }

    return input.cwd ? ctx.workspace.runInDirectory(input.cwd, runAction) : runAction()
  },
})

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

const codingAnalysisTools = {
  find_unused_exports: findUnusedExports,
  read_symbol: readSymbol,
}
export { codingAnalysisTools }
