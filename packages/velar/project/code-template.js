// velar:code 的代码模版：一段一个函数、一种用法，挑要的照着改。
// 结果的正文按 intent 放在各自的键上；先看 degraded 再决定信到什么程度。
import { analyze, query } from 'velar:code'

// 这个文件里有什么：大纲（符号、种类、范围）。
async function outline(path = 'src/user.ts') {
  const result = await query({ intent: 'outline', path })
  return { degraded: result.degraded, symbols: result.symbols }
}

// 定义在哪、谁在用它：只给名字就在整个项目里找，找到多个会把候选一起回来（每个候选带一份现成的 target）。
async function whoUses(symbol = 'UserService') {
  const definition = await query({ intent: 'definition', target: { symbol } })
  const references = await query({ intent: 'references', target: { symbol }, limit: 50 })
  return { definition: definition.definition ?? definition.candidates, references: references.references, degraded: references.degraded }
}

// 改之前看波及面：谁引了这个文件、改这个符号会影响谁。
async function blastRadius(path = 'src/user.ts', symbol = 'UserService') {
  const importers = await query({ intent: 'importers', path })
  const impact = await query({ intent: 'impact', target: { path, symbol } })
  return { importers: importers.importers, impact: impact.impact, degraded: [...importers.degraded, ...impact.degraded] }
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
