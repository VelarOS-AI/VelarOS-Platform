// velar:project 的代码模版：一段一个函数、一种用法，挑要的照着改。
import { edit, inspect, list, read, search, undo } from 'velar:project'

// 带行号地看一段：lines 每项是 [行号, 原文]；fileRef 是这段的编辑凭据，留着给 edit 用。
async function show(path = 'src/service.ts', from = 1, to = 80) {
  const [window] = (await read({ files: [{ path, range: [from, to] }] })).files
  return { fileRef: window.fileRef, totalLines: window.totalLines, text: window.lines.map(([line, text]) => `${line}: ${text}`).join('\n') }
}

// 改几处：range 选整行、match 选唯一的原文，两个一起给最稳；行号都按读到的那一版算。
async function renameCall(path = 'src/service.ts') {
  const [window] = (await read({ files: [{ path, range: [1, 200] }] })).files
  if (!window.fileRef) return window.note
  return edit({ steps: [{ action: 'edit', fileRef: window.fileRef, edits: [
    { op: 'replace', range: 42, match: 'oldCall()', text: 'newCall()' },
    { op: 'insert', at: 'end', text: 'export {}' },
  ] }] })
}

// 搜到就改：命中处的窗口带 fileRef，直接拿去 edit，不用再读。步骤在 edit 的入参里就地算，类型检查才认得出每一步是什么。
async function replaceEverywhere(query = 'loadSettings', replacement = 'readSettings') {
  const { files, truncated } = await search({ query, path: 'src' })
  if (truncated) return '命中太多，先收窄 query 或 path'
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

// 看看一次改动改了什么，不对就整次撤销。
async function review(changeRef = 'edit 回执里的 changeRef') {
  const change = await inspect({ changeRef })
  return change.diffLines > 200 ? undo({ changeRef }) : change.diff
}

// 列目录：depth 1 只列这一层，glob 相对 path 写；有下一页就带 cursor 接着列。
async function sourcesHere() {
  const first = await list({ path: 'src', include: ['*.ts'], depth: 1 })
  const rest = first.cursor ? (await list({ cursor: first.cursor })).entries : []
  return [...first.entries, ...rest].map((entry) => entry.path)
}
