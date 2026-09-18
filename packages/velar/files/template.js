// velar:files 的代码模版：挑一段照着改，import 只写一次。
// export default 交出来的东西才进你的上下文；读回来的行只落在程序的变量里。
import { edit, read, undo } from 'velar:files'

// 带行号地看一段：lines 每项是 [行号, 原文]，排成「行号: 原文」交出去最好读。
async function show(path = '~/.zshrc', from = 1, to = 80) {
  const [file] = (await read({ files: [{ path, range: [from, to] }] })).files
  if ('error' in file) throw new Error(file.error.message)
  return { totalLines: file.totalLines, text: file.lines.map(([line, text]) => `${line}: ${text}`).join('\n') }
}

// 大文件里只捞要的那几行（带行号），不把整份交出去。
async function findLines(path = '/var/log/system.log', pattern = /error/i) {
  const [log] = (await read({ files: [{ path }] })).files
  if ('error' in log) throw new Error(log.error.message)
  const hits = log.lines.filter(([, text]) => pattern.test(text))
  return { total: hits.length, last: hits.slice(-20).map(([line, text]) => `${line}: ${text}`) }
}

// 按行号改：先读拿到行号与 version，再把那几行换掉；行号只在那一版上成立，所以一定带上 version。
async function replaceLine(path = '~/.zshrc', from = /^export PATH=/, to = 'export PATH="$HOME/bin:$PATH"') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const hit = file.lines.find(([, text]) => from.test(text))
  if (!hit) return (await edit({ files: [{ path, version: file.version, edits: [{ after: file.totalLines, text: to }] }] })).changeId
  return (await edit({ files: [{ path, version: file.version, edits: [{ range: hit[0], text: to }] }] })).changeId
}

// 几处一起改：行号都按读到的那一版算，不用自己算前面的改动带来的错位；text 为空串就是删掉那几行。
async function tidy(path = 'notes.txt') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  return edit({ files: [{ path, version: file.version, edits: [
    { range: [3, 4], text: '' },
    { after: 0, text: '# 整理过' },
  ] }] })
}

// 整份写：在程序里算好全文再写回去（结构化的文件这样最稳）。换行写 \n，落盘时照原文件的风格存。
async function setJsonKey(path = 'config.json', key = 'debug', value = true) {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const config = JSON.parse(file.lines.map(([, text]) => text).join('\n'))
  config[key] = value
  return edit({ files: [{ path, version: file.version, newText: `${JSON.stringify(config, null, 2)}\n` }] })
}

// 新建文件：给 newText，缺的上级目录会自动建。
async function writeScript(path = '~/bin/hello.sh') {
  return edit({ files: [{ path, newText: '#!/bin/sh\necho hello\n' }] })
}

// 几个文件一起改：一批一次成败；写不下去时看 error.code 和 error.message 里逐条列的问题。
async function renameEverywhere(paths = ['a.txt', 'b.txt'], from = 'oldName', to = 'newName') {
  const { files } = await read({ files: paths.map((path) => ({ path })) })
  const changes = files.flatMap((f) => {
    if ('error' in f) return []
    const edits = f.lines.filter(([, text]) => text.includes(from)).map(([line, text]) => ({ range: line, text: text.replaceAll(from, to) }))
    return edits.length ? [{ path: f.path, version: f.version, edits }] : []
  })
  if (changes.length === 0) return '没有要改的'
  try {
    const result = await edit({ files: changes })
    return { changeId: result.changeId, files: result.files.map((f) => f.path) }
  } catch (error) {
    return { code: error.code, problems: error.message }
  }
}

// 改坏了就整次撤回：changeId 是 edit 结果里的那个号。
async function revert(changeId = 'edit 结果里的 changeId') {
  return undo({ changeId })
}

// 交出答案：export default 后面接你要给自己看的那一点东西。
export default await show()
