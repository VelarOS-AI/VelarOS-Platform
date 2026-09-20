// velaros:files 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 用的时候把要的那段放进程序，调用它并把要看的导出去，比如 `export default await showFile('~/.zshrc')`。
import { edit, read, undo } from 'velaros:files'

// 看一个文件：lines 每项是 [行号, 原文]，排成「行号: 原文」最好读。只要其中几行就在 files 里给 range: [首行, 末行]。
async function showFile(path = '~/.zshrc') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  return file.lines.map(([line, text]) => `${line}: ${text}`).join('\n')
}

// 在文件里找行（翻日志、找配置项）：整份读进程序里筛，只交出命中的那些行。
async function grepFile(path = '/var/log/system.log', pattern = /error/i, last = 30) {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const hits = file.lines.filter(([, text]) => pattern.test(text))
  return { total: hits.length, last: hits.slice(-last).map(([line, text]) => `${line}: ${text}`) }
}

// 一次读几个文件：读不了的那个单独是一项失败（用 'error' in 分开），别的照常。
async function readMany(paths = ['~/.gitconfig', '~/.npmrc']) {
  const { files } = await read({ files: paths.map((path) => ({ path })) })
  return files.map((file) => ('error' in file ? { path: file.path, error: file.error.message } : { path: file.path, text: file.lines.map(([, text]) => text).join('\n') }))
}

// 改一行配置：找到就换掉，找不到就加在末尾。行号只在读到的那一版上成立，所以带上 version。
async function setLine(path = '~/.zshrc', match = /^export EDITOR=/, line = 'export EDITOR=vim') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const found = file.lines.find(([, text]) => match.test(text))
  const change = found ? { range: found[0], text: line } : { after: file.totalLines, text: line }
  return edit({ files: [{ path, version: file.version, edits: [change] }] })
}

// 删掉几行：几处改动放进同一个 edits，行号都按读到的那一版算，不用管前面删掉的行带来的错位；text 为空串就是删掉。
async function deleteLines(path = '~/.zshrc', match = /^alias ll=/) {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const edits = file.lines.filter(([, text]) => match.test(text)).map(([line]) => ({ range: line, text: '' }))
  if (!edits.length) return '没有要删的行'
  return edit({ files: [{ path, version: file.version, edits }] })
}

// 改 JSON 配置：读出来解析，在程序里改好，再整份写回去（结构化的文件这样最稳）。
async function updateJson(path = '~/.config/app/settings.json', key = 'theme', value = 'dark') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const data = JSON.parse(file.lines.map(([, text]) => text).join('\n'))
  data[key] = value
  return edit({ files: [{ path, version: file.version, newText: `${JSON.stringify(data, null, 2)}\n` }] })
}

// 新建文件：给 newText 就行，缺的上级目录会自动建。不带 version 时文件已经在也会被整份替换，要防着就先读一次、带上它的 version。
async function createFile(path = '~/bin/hello.sh', text = '#!/bin/sh\necho hello\n') {
  return edit({ files: [{ path, newText: text }] })
}

// 几个文件里一起换掉一个词：一批一次成败；写不下去时整批不写，error.message 逐条写着是哪个文件、为什么。
async function replaceInFiles(paths = ['~/notes/a.md', '~/notes/b.md'], from = 'oldName', to = 'newName') {
  const { files } = await read({ files: paths.map((path) => ({ path })) })
  const changes = []
  for (const file of files) {
    if ('error' in file) continue
    const edits = file.lines.filter(([, text]) => text.includes(from)).map(([line, text]) => ({ range: line, text: text.replaceAll(from, to) }))
    if (edits.length) changes.push({ path: file.path, version: file.version, edits })
  }
  if (!changes.length) return '没有要改的'
  const result = await edit({ files: changes })
  return { changeId: result.changeId, changed: result.files.map((file) => file.path) }
}

// 改坏了就整次撤回：changeId 是 edit 结果里的那个号，那次改的文件一起回到改之前。
async function revert(changeId = 'edit 结果里的 changeId') {
  return undo({ changeId })
}
