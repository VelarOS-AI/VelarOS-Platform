import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

/** 只解析当前测试脚本使用的字面命令与 && 链，不推断变量或复杂 shell。 */
function literalCommands(script) {
  const commands = []
  let words = []
  let word = ''
  let started = false
  let quote
  const finishWord = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  for (let index = 0; index < script.length; index++) {
    const char = script[index]
    if (quote) {
      if (char === quote) quote = undefined
      else if (quote === '"' && (char === '$' || char === '`')) return []
      else if (quote === '"' && char === '\\') {
        const next = script[++index]
        if (!next || !['"', '\\'].includes(next)) return []
        word += next
      } else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/u.test(char)) finishWord()
    else if (char === '#' && !started) break
    else if (char === '&' && script[index + 1] === '&') {
      finishWord()
      if (!words.length) return []
      commands.push(words)
      words = []
      index++
    } else if (/[;&|<>$`()]/u.test(char)) return []
    else if (char === '\\') {
      const next = script[++index]
      if (!next || !/[\s'"\\]/u.test(next)) return []
      word += next
      started = true
    } else {
      word += char
      started = true
    }
  }
  if (quote) return []
  finishWord()
  if (!words.length) return []
  return [...commands, words]
}

/** 只接受不筛选用例的当前 Bun/Node 测试命令，未知选项不作为执行证据。 */
function testPaths(words) {
  const bun = words[0] === 'bun' && words[1] === 'test'
  const node = words[0] === 'node' && words[1] === '--test'
  if (!bun && !node) return undefined
  const paths = []
  let positional = false
  for (let index = 2; index < words.length; index++) {
    const word = words[index]
    if (!positional && word === '--') {
      positional = true
      continue
    }
    if (!positional && word.startsWith('-')) {
      const option = bun ? '--timeout' : '--test-concurrency'
      const value =
        word === option
          ? words[++index]
          : word.startsWith(`${option}=`)
            ? word.slice(option.length + 1)
            : undefined
      if (!value || !/^[1-9]\d*$/u.test(value)) return undefined
      continue
    }
    if (!word || /[*?{}[\]]/u.test(word)) return undefined
    paths.push(word)
  }
  return { bun, paths: bun && !paths.length ? ['.'] : paths }
}

/** 路径包含关系按原生分量核对，邻名目录与跨盘路径不算子项。 */
function inside(root, target) {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** 不存在的参数不能证明执行；其他文件系统错误仍交给检查器报告。 */
function existingPath(path) {
  try {
    return { path: realpathSync(path), stat: statSync(path) }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

/** 核对真实测试文件是否被直接命令覆盖；只有 Bun 目录参数按测试命名递归发现。 */
export function testScriptRunsFile(packageRoot, script, file) {
  const root = resolve(packageRoot)
  const realRoot = realpathSync(root)
  const target = resolve(root, file)
  if (
    !inside(root, target) ||
    !/[._](?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs)$/u.test(basename(target))
  )
    return false
  const actual = existingPath(target)
  if (!actual?.stat.isFile() || !inside(realRoot, actual.path)) return false
  for (const command of literalCommands(script)) {
    const selected = testPaths(command)
    if (!selected) {
      // 当前构建/门禁是独立子进程，不改变后续测试的工作目录。
      if (command[0] === 'bun' && command[1] === 'run' && command.length === 3) continue
      return false
    }
    for (const argument of selected.paths) {
      const path = resolve(root, argument)
      if (!inside(root, path)) continue
      const entry = existingPath(path)
      if (!entry || !inside(realRoot, entry.path)) continue
      if (entry.stat.isFile() && entry.path === actual.path) return true
      if (selected.bun && entry.stat.isDirectory() && inside(entry.path, actual.path)) {
        const parts = relative(entry.path, actual.path).split(sep)
        if (!parts.some((part) => part === 'node_modules' || part === '.git')) return true
      }
    }
  }
  return false
}
