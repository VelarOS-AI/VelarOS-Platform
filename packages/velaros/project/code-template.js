// velaros:code 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 结果的正文按 intent 放在各自的键上，全部交回；先看 degraded 再决定信到什么程度。
import { analyze, query } from 'velaros:code'

// 这个文件里有什么：大纲（名字、种类、行号）；每个符号带一份现成的 target，下一次查询原样传回来就行。
async function outline(path = 'src/user.ts') {
  const { symbols, degraded } = await query({ intent: 'outline', path })
  return { degraded, symbols: symbols.map((symbol) => `${symbol.line}: ${symbol.kind} ${symbol.name}`) }
}

// 定义在哪、谁在用它：只给名字就在整个项目里找；同名的有好几个时 symbols 里是候选，挑一个把它的 target 原样传回来。
async function whoUses(symbol = 'UserService') {
  const found = await query({ intent: 'definition', target: { symbol } })
  const [chosen] = found.symbols
  const refs = await query({ intent: 'references', target: chosen.target })
  return { declaration: found.declaration, candidates: found.symbols.length, references: refs.references, degraded: refs.degraded }
}

// 引用多时在程序里汇总：按文件数一数，只导出要看的。coverage.truncated 为真是后端没给全。
async function referenceCounts(symbol = 'UserService') {
  const result = await query({ intent: 'references', target: { symbol } })
  const references = result.references ?? []
  /** @type {Record<string, number>} */
  const perFile = {}
  for (const reference of references) perFile[reference.path] = (perFile[reference.path] ?? 0) + 1
  return { total: references.length, perFile, complete: !result.coverage.truncated }
}

// 改之前看波及面：谁引了这个文件、改这个符号会波及哪些引用和测试。
async function blastRadius(path = 'src/user.ts', symbol = 'UserService') {
  const importers = await query({ intent: 'importers', path })
  const impact = await query({ intent: 'impact', target: { path, symbol } })
  return { importers: importers.importers, references: impact.references, tests: impact.relatedTestPaths, degraded: [...importers.degraded, ...impact.degraded] }
}

// 改完之后看这个文件报什么错：只交出错误；degraded 不为空时，空诊断不等于没问题。
async function errorsIn(path = 'src/user.ts') {
  const { diagnostics, degraded } = await query({ intent: 'diagnostics', path })
  const errors = diagnostics.filter((item) => item.severity === 'error')
  return { errors: errors.map((item) => `${item.path}:${item.line} ${item.message}`), degraded }
}

// 要图后端的分析（依赖环、死代码、调用路径、路由）：没接图后端时整个调用失败（UNAVAILABLE），这时改用 query 的 references、impact。
async function dependencyCycles() {
  try {
    return (await analyze({ intent: 'cycles' })).cycles
  } catch (error) {
    return error.code === 'UNAVAILABLE' ? '没有代码图谱后端' : error.message
  }
}
