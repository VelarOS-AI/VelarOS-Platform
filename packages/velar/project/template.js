// velar:project 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 用的时候把要的那段放进程序，调用它并把要看的导出去，比如 `export default await showFile('src/index.ts')`。
import { edit, inspect, list, read, search, undo } from 'velar:project'

// 看一个文件：不给 range 就是整个文件；lines 每项是 [行号, 原文]，排成「行号: 原文」最好读。
async function showFile(path = 'src/index.ts') {
  const [window] = (await read({ files: [{ path }] })).files
  return window.lines.map(([line, text]) => `${line}: ${text}`).join('\n')
}

// 看一个函数：先 search 找到它在哪个文件哪一行，再只读那附近几十行。fileRef 留着，接着改就用它。
async function showFunction(name = 'loadSettings', path = 'src') {
  const { hits } = await search({ query: `function ${name}`, path })
  const hit = hits[0]
  if (!hit?.range) return `没找到 function ${name}`
  const start = hit.range.startLine
  const [window] = (await read({ files: [{ path: hit.path, range: [start, start + 40] }] })).files
  return { path: hit.path, fileRef: window.fileRef, text: window.lines.map(([line, text]) => `${line}: ${text}`).join('\n') }
}

// 一次读几个文件（配置、入口）：读不到的不在 files 里，在 issues 里各带原因和下一步。
async function readConfigs(paths = ['package.json', 'tsconfig.json']) {
  const { files, issues } = await read({ files: paths.map((path) => ({ path })) })
  return { files: files.map((window) => ({ path: window.path, text: window.lines.map(([, text]) => text).join('\n') })), issues }
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

// 改一个文件里的几处：range 选整行、match 选一段唯一的原文，两个一起给最稳；行号都按读到的那一版算。
async function editFile(path = 'src/service.ts', from = 'oldCall(', to = 'newCall(') {
  const [window] = (await read({ files: [{ path }] })).files
  if (!window.fileRef) return window.note
  const target = window.lines.find(([, text]) => text.includes(from))
  if (!target) return `没找到 ${from}`
  return edit({ steps: [{ action: 'edit', fileRef: window.fileRef, edits: [
    { op: 'replace', range: target[0], match: from, text: to },
    { op: 'insert', at: 'start', text: "import { newCall } from './calls.js'" },
  ] }] })
}

// 搜到就改（改名）：命中处的窗口带 fileRef，直接拿去 edit，不用再读；所有文件的改动合成一个事务，全成或全不成。
// 步骤在 edit 的入参里就地算，类型检查才认得出每一步是什么。
async function renameEverywhere(from = 'loadSettings', to = 'readSettings') {
  const { files } = await search({ query: from, path: 'src' })
  const targets = files.filter((window) => window.fileRef)
  if (!targets.length) return '没有要改的'
  return edit({ steps: targets.map((window) => ({
    action: 'edit',
    fileRef: window.fileRef ?? '',
    edits: window.lines.filter(([, text]) => text.includes(from)).map(([line, text]) => ({ op: 'replace', range: line, text: text.replaceAll(from, to) })),
  })) })
}

// 改失败了看原因：error.code 说是哪一种（文件又被改过、match 找不到或不唯一、改完没过校验……），error.message 里有位置和下一步。
async function replaceOnce(path = 'src/config.ts', from = 'const retries = 3', to = 'const retries = 5') {
  const [window] = (await read({ files: [{ path }] })).files
  if (!window.fileRef) return window.note
  try {
    return await edit({ steps: [{ action: 'edit', fileRef: window.fileRef, edits: [{ op: 'replace', match: from, text: to }] }] })
  } catch (error) {
    return { code: error.code, message: error.message }
  }
}

// 新建一个文件并在另一个文件里用上它：几步合成一个事务；新建的文件在后面的步骤里用 path 指。
async function addModule(importer = 'src/index.ts', path = 'src/cache.ts') {
  const [window] = (await read({ files: [{ path: importer, range: 1 }] })).files
  if (!window.fileRef) return window.note
  return edit({ steps: [
    { action: 'create', path, text: 'export const cache = new Map()\n' },
    { action: 'edit', fileRef: window.fileRef, edits: [{ op: 'insert', at: 'start', text: "import { cache } from './cache.js'" }] },
  ] })
}

// 文件改名，里面的类名也跟着改：前面的步骤动过的文件改用 sourceRef（填同一个原 fileRef），坐标按改完后的内容算。
async function renameFile(path = 'src/old-name.ts', to = 'src/new-name.ts', oldName = 'OldName', newName = 'NewName') {
  const [window] = (await read({ files: [{ path }] })).files
  if (!window.fileRef) return window.note
  return edit({ steps: [
    { action: 'move', fileRef: window.fileRef, to },
    { action: 'edit', sourceRef: window.fileRef, edits: window.lines.filter(([, text]) => text.includes(oldName)).map(([line, text]) => ({ op: 'replace', range: line, text: text.replaceAll(oldName, newName) })) },
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
