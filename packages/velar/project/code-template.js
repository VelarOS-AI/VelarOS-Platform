// velar:code 的代码模版：一段一个函数、一种用法，挑要的照着改。
// 结果的正文按 intent 放在各自的键上，全部交回；先看 degraded 再决定信到什么程度。
import { analyze, query } from 'velar:code'

// 这个文件里有什么：大纲（符号、种类、范围），每个符号带一份现成的 target。
async function outline(path = 'src/user.ts') {
  const result = await query({ intent: 'outline', path })
  return { degraded: result.degraded, symbols: result.symbols }
}

// 定义在哪、谁在用它：只给名字就在整个项目里找；同名的有好几个时 symbols 里是候选，挑一个把它的 target 原样传回来。
async function whoUses(symbol = 'UserService') {
  const definition = await query({ intent: 'definition', target: { symbol } })
  const [chosen] = definition.symbols
  const references = await query({ intent: 'references', target: chosen.target })
  return { declaration: definition.declaration, candidates: definition.symbols.length, references: references.references, degraded: references.degraded }
}

// 结果多时在程序里汇总：按文件数一数引用，只导出要看的。coverage.truncated 为真是后端没给全。
async function referenceCounts(symbol = 'UserService') {
  const result = await query({ intent: 'references', target: { symbol } })
  /** @type {Record<string, number>} */
  const perFile = {}
  for (const reference of result.references ?? []) perFile[reference.path] = (perFile[reference.path] ?? 0) + 1
  return { total: (result.references ?? []).length, perFile, complete: !result.coverage.truncated }
}

// 改之前看波及面：谁引了这个文件、改这个符号会波及哪些引用和测试。
async function blastRadius(path = 'src/user.ts', symbol = 'UserService') {
  const importers = await query({ intent: 'importers', path })
  const impact = await query({ intent: 'impact', target: { path, symbol } })
  return { importers: importers.importers, references: impact.references, tests: impact.relatedTestPaths, degraded: [...importers.degraded, ...impact.degraded] }
}

// 改完之后看这个文件报什么错；空诊断在 degraded 不为空时不等于没问题。
async function diagnostics(path = 'src/user.ts') {
  const result = await query({ intent: 'diagnostics', path })
  return { diagnostics: result.diagnostics, degraded: result.degraded }
}

// 要图后端的分析：没接图后端时整个调用失败（UNAVAILABLE），这时改用 query 的 references、impact。
async function dependencyCycles() {
  try {
    return (await analyze({ intent: 'cycles' })).cycles
  } catch (error) {
    return error.code === 'UNAVAILABLE' ? '没有代码图谱后端' : error.message
  }
}
