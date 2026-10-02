// velaros:project 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 用的时候把要的那段放进程序，调用它并把要看的导出去，比如 `export default await showFile('src/index.ts')`。
import { edit, inspect, list, read, search, snapshot, undo } from 'velaros:project'

// 捕获当前文件纯值：每次仍真实前后读取；不能把 fingerprint 当作历史变化代次或编辑凭据。
async function captureConfigs(path = 'package.json') {
  return snapshot({ files: [{ path, key: 'package', purpose: '当前配置', format: 'json', view: 'full' }] })
}

// 看一个文件：不给 range 就是整个文件；text 是连续的正文，startLine 是它第一行的行号。
async function showFile(path = 'src/index.ts') {
  const [window] = (await read({ files: [{ path }] })).files
  return window.text
}

// 看一个函数：先 search 找到它在哪个文件哪一行，再只读那附近几十行。
async function showFunction(name = 'loadSettings', path = 'src') {
  const { hits } = await search({ query: `function ${name}`, path })
  const hit = hits[0]
  if (!hit?.range) return `没找到 function ${name}`
  const start = hit.range.startLine
  const [window] = (await read({ files: [{ path: hit.path, range: [start, start + 40] }] })).files
  return { path: hit.path, startLine: window.startLine, text: window.text }
}

// 一次读几个文件（配置、入口）：读不到的不在 files 里，在 issues 里各带原因和下一步。
async function readConfigs(paths = ['package.json', 'tsconfig.json']) {
  const { files, issues } = await read({ files: paths.map((path) => ({ path })) })
  return { files: files.map((window) => ({ path: window.path, text: window.text })), issues }
}

// 看目录结构：depth 1 只列这一层，2 再往下一层，不给就是整棵树；.gitignore 忽略的本来就不列。
async function tree(path = '.', depth = 2) {
  const { entries } = await list({ path, depth })
  return entries.map((entry) => (entry.type === 'directory' ? `${entry.path}/` : entry.path)).join('\n')
}

// 找文件：list 交回全部条目，glob 相对 path 写（不带 / 的按文件名、任意深度都算）。
async function findFiles(path = 'src', pattern = '*.test.ts') {
  const { entries } = await list({ path, include: [pattern] })
  return entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
}

// 用的地方很多时先在程序里汇总：search 交回全部命中，按文件数一数，只导出要看的。
async function whereUsed(query = 'useSettings') {
  const { hits } = await search({ query, include: ['*.ts', '*.tsx'] })
  /** @type {Record<string, number>} */
  const perFile = {}
  for (const hit of hits) perFile[hit.path] = (perFile[hit.path] ?? 0) + 1
  return { total: hits.length, perFile }
}

// 改一处：把一段原文换成新文，oldText 照读到的原文写、在文件里要唯一（出现好几处就多带几行上下文）。
async function replaceOnce(path = 'src/config.ts', oldText = 'const retries = 3', newText = 'const retries = 5') {
  try {
    return await edit({ steps: [{ action: 'replace', path, oldText, newText }] })
  } catch (error) {
    // error.code：TARGET_NOT_FOUND 是没找到（message 里有最接近的原文），AMBIGUOUS_TARGET 是有好几处。
    return { code: error.code, message: error.message }
  }
}

// 写一个文件：write 把 text 整份写进去，文件不存在就新建（上级目录自动建）。
async function writeFile(path = 'src/cache.ts', text = 'export const cache = new Map()\n') {
  return edit({ steps: [{ action: 'write', path, text }] })
}

// 全文替换：先 read 整个文件，在程序里 replaceAll，再 write 整份写回。
async function renameInFile(path = 'src/service.ts', from = 'oldCall(', to = 'newCall(') {
  const [window] = (await read({ files: [{ path }] })).files
  if (!window.text.includes(from)) return `没找到 ${from}`
  return edit({ steps: [{ action: 'write', path, text: window.text.replaceAll(from, to) }] })
}

// 搜到就改（改名）：一次批量读完命中文件，再用一次 edit 提交事务；有读取缺口时先交回缺口，不缩小修改范围。
async function renameEverywhere(from = 'loadSettings', to = 'readSettings') {
  const { hits } = await search({ query: from, path: 'src' })
  const paths = [...new Set(hits.map((hit) => hit.path))]
  if (!paths.length) return { status: 'unchanged', matchedFiles: [] }
  return replaceInFiles(paths, from, to)
}

// 指定文件一起替换：全部正文进程序，模型只看真实改动的文件与 changeRef；完整 diff 可用 inspect 召回。
// 超过 read 或事务上限时按任务的独立范围拆分；多个 edit 各自是事务，不能称为一个整体事务。
async function replaceInFiles(paths = ['src/a.ts', 'src/b.ts'], from = 'oldName', to = 'newName') {
  const targets = [...new Set(paths)]
  if (!targets.length) return { status: 'unchanged', matchedFiles: [] }
  const { files, issues = [] } = await read({ files: targets.map((path) => ({ path })) })
  if (issues.length) return { status: 'blocked', requestedFiles: targets, issues }
  /** @type {Array<{ action: 'write', path: string, text: string }>} */
  const steps = files
    .filter((window) => window.text.includes(from))
    .map((window) => ({ action: 'write', path: window.path, text: window.text.replaceAll(from, to) }))
  if (!steps.length) return { status: 'unchanged', matchedFiles: [] }
  const changed = await edit({ steps })
  return { status: 'committed', changeRef: changed.changeRef, changedFiles: changed.changedFiles, diffLines: changed.diffLines }
}

// 新建一个文件并在另一个文件里用上它：几步合成一个事务，后一步按前一步改完的内容算。
async function addModule(importer = 'src/index.ts', path = 'src/cache.ts', firstLine = "import { load } from './load.js'") {
  return edit({ steps: [
    { action: 'write', path, text: 'export const cache = new Map()\n' },
    { action: 'replace', path: importer, oldText: firstLine, newText: `${firstLine}\nimport { cache } from './cache.js'` },
  ] })
}

// 文件改名，里面的类名也跟着改：move 之后按新路径接着改。
async function renameFile(path = 'src/old-name.ts', to = 'src/new-name.ts', oldName = 'class OldName', newName = 'class NewName') {
  return edit({ steps: [
    { action: 'move', path, to },
    { action: 'replace', path: to, oldText: oldName, newText: newName },
  ] })
}

// 看一次改动改了什么：diff 是完整差量。
async function review(changeRef = 'edit 回执里的 changeRef') {
  const change = await inspect({ changeRef })
  return { status: change.status, files: change.changedFiles, diff: change.diff }
}

// 改错了就整次撤销：写回原文、删掉那次新建的文件。
async function revert(changeRef = 'edit 回执里的 changeRef') {
  return undo({ changeRef })
}
