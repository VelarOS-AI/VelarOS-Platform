// velaros:files 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 用的时候把要的那段放进程序，调用它并把要看的导出去，比如 `export default await showFile('~/.zshrc')`。
import { edit, read, undo } from 'velaros:files'

// 看一个文件：text 是连续的正文，startLine 是它第一行的行号。只要其中几行就在 files 里给 range: [首行, 末行]。
async function showFile(path = '~/.zshrc') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  return file.text
}

// 在文件里找行（翻日志、找配置项）：整份读进程序里筛，只交出命中的那些行，带上行号好定位。
async function grepFile(path = '/var/log/system.log', pattern = /error/i, last = 30) {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const hits = file.text
    .split('\n')
    .map((text, index) => ({ line: file.startLine + index, text }))
    .filter(({ text }) => pattern.test(text))
  return { total: hits.length, last: hits.slice(-last).map(({ line, text }) => `${line}: ${text}`) }
}

// 一次读几个文件：读不了的那个单独是一项失败（用 'error' in 分开），别的照常。
async function readMany(paths = ['~/.gitconfig', '~/.npmrc']) {
  const { files } = await read({ files: paths.map((path) => ({ path })) })
  return files.map((file) => ('error' in file ? { path: file.path, error: file.error.message } : { path: file.path, text: file.text }))
}

// 改一处：把一段原文换成新文。oldText 照读到的原文写、在文件里只能出现一次（出现好几处就多带几行上下文）。
async function replaceOnce(path = '~/.zshrc', oldText = 'export EDITOR=nano', newText = 'export EDITOR=vim') {
  try {
    return await edit({ steps: [{ action: 'replace', path, oldText, newText }] })
  } catch (error) {
    // 找不到或不唯一时整次不写：error.message 里有最像的几行，或者出现在第几行。
    return { code: error.code, message: error.message }
  }
}

// 改一行配置：有就换掉，没有就加在末尾。先读出来按行在程序里改，再整份写回去。
async function setLine(path = '~/.zshrc', match = /^export EDITOR=/, line = 'export EDITOR=vim') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const lines = file.text.split('\n')
  const at = lines.findIndex((text) => match.test(text))
  // 文件以换行结尾时，split 出来的最后一项是空串：新行插在它前面，结尾的换行照旧。
  if (at >= 0) lines[at] = line
  else lines.splice(lines.at(-1) === '' ? -1 : lines.length, 0, line)
  return edit({ steps: [{ action: 'write', path, text: lines.join('\n') }] })
}

// 删掉几行：读出来在程序里过滤掉，整份写回去。读到文件末尾时 text 带着结尾的换行，原样拼回去不多不少。
async function deleteLines(path = '~/.zshrc', match = /^alias ll=/) {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const lines = file.text.split('\n')
  const kept = lines.filter((text) => !match.test(text))
  if (kept.length === lines.length) return '没有要删的行'
  return edit({ steps: [{ action: 'write', path, text: kept.join('\n') }] })
}

// 改 JSON 配置：读出来解析，在程序里改好，再整份写回去（结构化的文件这样最稳）。
async function updateJson(path = '~/.config/app/settings.json', key = 'theme', value = 'dark') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const data = JSON.parse(file.text)
  data[key] = value
  return edit({ steps: [{ action: 'write', path, text: `${JSON.stringify(data, null, 2)}\n` }] })
}

// 新建文件：write 给出全部内容就行，缺的上级目录会自动建；文件已经在就整份换掉。
async function createFile(path = '~/bin/hello.sh', text = '#!/bin/sh\necho hello\n') {
  return edit({ steps: [{ action: 'write', path, text }] })
}

// 几个文件一起替换：一次批量 read、一次 edit；有读取失败时先交回全部失败项，不跳过它们继续修改。
// 规划失败一个都不写；提交是逐文件原子写入，途中失败按原报错中的已写路径和可用撤回号处理，先 read 现状再决定，不整批重发。
async function replaceInFiles(paths = ['~/notes/a.md', '~/notes/b.md'], from = 'oldName', to = 'newName') {
  const requested = [...new Set(paths)]
  if (!requested.length) return { status: 'unchanged', changed: [] }
  const { files } = await read({ files: requested.map((path) => ({ path })) })
  const gaps = files.filter((file) => 'error' in file)
  if (gaps.length) return { status: 'blocked', requestedFiles: requested, gaps }
  /** @type {Array<{ action: 'write', path: string, text: string }>} */
  const steps = files.flatMap((file) => !('error' in file) && file.text.includes(from)
    ? [{ action: 'write', path: file.path, text: file.text.replaceAll(from, to) }]
    : [])
  if (!steps.length) return { status: 'unchanged', changed: [] }
  const result = await edit({ steps })
  return { status: 'committed', changeId: result.changeId, undoable: result.undoable, changed: result.files.map((file) => file.path) }
}

// 改坏了就整次撤回：changeId 是 edit 结果里的那个号，逐项恢复那次改动；若中途失败，报错列出已恢复文件，再次 undo 会接着处理。
async function revert(changeId = 'edit 结果里的 changeId') {
  return undo({ changeId })
}
