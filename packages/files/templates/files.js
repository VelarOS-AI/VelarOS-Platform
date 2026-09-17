// velar:files 的代码模版：挑一段照着改，import 只写一次。
// export default 交出来的东西才进你的上下文；读回来的正文只落在程序的变量里。
import { edit, read, view } from 'velar:files'

// 读一个不知道多大的文件：先看大小，再决定交出多少。
async function readUnknownSize(path = 'README.md') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  return file.content.length <= 20000
    ? file.content
    : { chars: file.content.length, head: file.content.slice(0, 4000) }
}

// 大日志里只捞错误行，不把整份交出去。
async function findErrors(path = 'build.log') {
  const [log] = (await read({ files: [{ path }] })).files
  if ('error' in log) throw new Error(log.error.message)
  const errors = log.content.split('\n').filter((line) => line.includes('ERROR'))
  return { total: errors.length, last: errors.slice(-20) }
}

// 一批文件只看开头；读不了的那一项单独是失败，别的照常。
async function headsOf(paths = ['src/a.ts', 'src/b.ts']) {
  const { files } = await read({ files: paths.map((path) => ({ path })) })
  return files.map((f) => ('error' in f ? { path: f.path, error: f.error.message } : { path: f.path, head: f.content.slice(0, 300) }))
}

// 改文件：在程序里把内容改好，带着 read 给的 version 整份写回去——中间被人改过就不写。
async function replaceInFile(path = 'config.json', from = '"debug": false', to = '"debug": true') {
  const [file] = (await read({ files: [{ path }] })).files
  if ('error' in file) throw new Error(file.error.message)
  const next = file.content.replace(from, to)
  if (next === file.content) throw new Error(`没找到要改的那一处：${from}`)
  return (await edit({ files: [{ path, newText: next, version: file.version }] })).files
}

// 几个文件一起改：一批一次成败；写不下去时看 error.code 和 error.message 里逐条列的问题。
async function renameEverywhere(paths = ['src/a.ts', 'src/b.ts'], from = 'oldName', to = 'newName') {
  const { files } = await read({ files: paths.map((path) => ({ path })) })
  const changes = files.flatMap((f) => ('error' in f || !f.content.includes(from) ? [] : [{ path: f.path, newText: f.content.replaceAll(from, to), version: f.version }]))
  if (changes.length === 0) return '没有要改的'
  try {
    return (await edit({ files: changes })).files.map((f) => f.path)
  } catch (error) {
    return { code: error.code, problems: error.message }
  }
}

// 改坏了就回滚：edit 回执里的 previousVersion 就是改动前的那一版。
async function undo(path = 'config.json', previousVersion = 'edit 回执里的 previousVersion') {
  return (await edit({ files: [{ path, restore: previousVersion }] })).files
}

// 看图：在范围内原样给你，大图会压小；结果里 sent 比原图小就说明压过。
// 图不在返回值里，跟在结果后面给你看，只给你看一次：你一回应就撤掉，要再看就再调一次 view。
async function lookAt(path = 'screen.png') {
  const [image] = (await view({ files: [{ path }] })).files
  return image
}

// 压小之后看不清的地方，用 region 单独要那一块（按原图像素算）；原图尺寸在上一次 view 的结果里。
async function zoomTopRight(path = 'screen.png', width = 3840, height = 2160) {
  const region = { x: Math.floor(width / 2), y: 0, width: Math.ceil(width / 2), height: Math.ceil(height / 2) }
  return (await view({ files: [{ path, region }] })).files
}

// 交出答案：export default 后面接你要给自己看的那一点东西。
export default await readUnknownSize()
