// velar:project 的代码模版：一段一个函数、一种用法，挑要的照着改。
import { edit, inspect, list, read, search, undo } from 'velar:project'

// 读：不给 range 是整个文件，给了只读那几行。lines 每项是 [行号, 原文]，全在程序的变量里，看多少自己挑；fileRef 是编辑凭据，留着给 edit 用。
async function todos(path = 'src/service.ts') {
  const [window] = (await read({ files: [{ path }] })).files
  const found = window.lines.filter(([, text]) => text.includes('TODO'))
  return { fileRef: window.fileRef, totalLines: window.totalLines, todos: found.map(([line, text]) => `${line}: ${text}`) }
}

// 一次读几个文件：读不到的在 issues 里（各带原因和下一步），读到的照常在 files 里。
async function heads(paths = ['src/a.ts', 'src/b.ts']) {
  const { files, issues } = await read({ files: paths.map((path) => ({ path, range: [1, 20] })) })
  return { heads: files.map((window) => ({ path: window.path, text: window.lines.map(([, text]) => text).join('\n') })), issues }
}

// 改几处：range 选整行、match 选唯一的原文，两个一起给最稳；行号都按读到的那一版算。
async function renameCall(path = 'src/service.ts') {
  const [window] = (await read({ files: [{ path }] })).files
  if (!window.fileRef) return window.note
  return edit({ steps: [{ action: 'edit', fileRef: window.fileRef, edits: [
    { op: 'replace', range: 42, match: 'oldCall()', text: 'newCall()' },
    { op: 'insert', at: 'end', text: 'export {}' },
  ] }] })
}

// 命中很多时在程序里汇总：search 交回全部命中，按文件数一数，只导出要看的。
async function whereUsed(query = 'useSettings') {
  const { hits } = await search({ query, include: ['*.ts', '*.tsx'] })
  /** @type {Record<string, number>} */
  const perFile = {}
  for (const hit of hits) perFile[hit.path] = (perFile[hit.path] ?? 0) + 1
  return { total: hits.length, perFile }
}

// 搜到就改：命中处的窗口带 fileRef，直接拿去 edit，不用再读。步骤在 edit 的入参里就地算，类型检查才认得出每一步是什么。
async function replaceEverywhere(query = 'loadSettings', replacement = 'readSettings') {
  const { files } = await search({ query, path: 'src' })
  const targets = files.filter((window) => window.fileRef && window.lines.some(([, text]) => text.includes(query)))
  if (!targets.length) return '没有要改的'
  return edit({ steps: targets.map((window) => ({
    action: 'edit',
    fileRef: window.fileRef ?? '',
    edits: window.lines.filter(([, text]) => text.includes(query)).map(([line]) => ({ op: 'replace', range: line, match: query, text: replacement })),
  })) })
}

// 新建一个文件并在另一个文件里引它：两步合成一个事务，全成或全不成；新建的文件后面用 path 指。
async function addModule(importer = 'src/index.ts') {
  const [window] = (await read({ files: [{ path: importer, range: 1 }] })).files
  if (!window.fileRef) return window.note
  return edit({ steps: [
    { action: 'create', path: 'src/cache.ts', text: 'export const cache = new Map()\n' },
    { action: 'edit', fileRef: window.fileRef, edits: [{ op: 'insert', at: 'start', text: "import './cache.js'" }] },
  ] })
}

// 改名之后再改内容：前面的步骤动过的文件改用 sourceRef（填同一个原 fileRef），坐标按改完后的内容算。
async function moveAndFix(path = 'src/old.ts') {
  const [window] = (await read({ files: [{ path, range: [1, 20] }] })).files
  if (!window.fileRef) return window.note
  return edit({ steps: [
    { action: 'move', fileRef: window.fileRef, to: 'src/new.ts' },
    { action: 'edit', sourceRef: window.fileRef, edits: [{ op: 'replace', range: 1, match: 'Old', text: 'New' }] },
  ] })
}

// 文件在读完之后被改过：message 里有新的行号和新 fileRef 时，换上它重提；没有就重读。
async function editOrExplain(path = 'src/service.ts') {
  const [window] = (await read({ files: [{ path, range: [40, 50] }] })).files
  if (!window.fileRef) return window.note
  try {
    return await edit({ steps: [{ action: 'edit', fileRef: window.fileRef, edits: [{ op: 'replace', range: 42, text: '  return value' }] }] })
  } catch (error) {
    return { code: error.code, message: error.message }
  }
}

// 看看一次改动改了什么（完整差量），不对就整次撤销。
async function review(changeRef = 'edit 回执里的 changeRef') {
  const change = await inspect({ changeRef })
  return change.diffLines > 200 ? undo({ changeRef }) : change.diff
}

// 列目录：不给 depth 是整棵树、全部条目都交回，在程序里筛；depth 1 只列这一层。glob 相对 path 写。
async function testFiles() {
  const { entries } = await list({ path: 'src', include: ['*.test.ts'] })
  return entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
}
