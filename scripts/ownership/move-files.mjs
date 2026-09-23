#!/usr/bin/env bun
// 按移动表搬一个包里的文件，并改写全仓库里受影响的相对 import。
//
// 用法：bun scripts/ownership/move-files.mjs <包目录，如 packages/project> <移动表.json> [--dry-run]
// 移动表是 { "旧路径": "新路径" }，路径相对包目录（src、test、spec、scripts 下的都可以）。
//
// 做的事：
//   1. 核对旧路径都存在、新路径不撞已有文件、同一个新路径不被两个旧路径占用；
//   2. 读全仓库的 TypeScript / JavaScript 源文件（不含 node_modules、dist），找出 import / export from、
//      import type、import('…') 里的相对路径，按旧位置解析到真实文件，再按新位置算出新的相对路径；
//      原来写不写扩展名、写 .js 还是 .ts 都照原样保留，指向目录 index 的改成直接指向文件；
//   3. 用 git mv 搬文件（自动建目录），再把改写后的内容写到新位置。
// 不删任何目录；搬空的旧目录由调用方确认后自己处理。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import ts from 'typescript'

const RepoRoot = resolve(import.meta.dir, '../..')
const [packageArg, mapArg, ...flags] = process.argv.slice(2)
if (!packageArg || !mapArg) {
  console.error('用法：bun scripts/ownership/move-files.mjs <包目录> <移动表.json> [--dry-run]')
  process.exit(2)
}
const dryRun = flags.includes('--dry-run')
const packageRoot = resolve(RepoRoot, packageArg)
if (!packageRoot.startsWith(`${RepoRoot}${sep}packages${sep}`)) {
  console.error(`包目录必须在 packages/ 之下：${packageRoot}`)
  process.exit(2)
}
const moveTable = JSON.parse(readFileSync(resolve(mapArg), 'utf8'))

/** 相对包目录的路径转成绝对路径。 */
const inPackage = (path) => resolve(packageRoot, path)

const moves = new Map()
const failures = []
const seenTargets = new Map()
for (const [from, to] of Object.entries(moveTable)) moves.set(inPackage(from), inPackage(to))
for (const [from, to] of Object.entries(moveTable)) {
  const source = inPackage(from)
  const target = inPackage(to)
  if (!existsSync(source)) failures.push(`旧路径不存在：${from}`)
  // 新路径上已有文件，只有它自己也在这次被搬走时才行。
  if (existsSync(target) && !moves.has(target)) failures.push(`新路径已有文件：${to}`)
  if (seenTargets.has(target)) failures.push(`${from} 与 ${seenTargets.get(target)} 都搬到 ${to}`)
  seenTargets.set(target, from)
  if (!target.startsWith(`${packageRoot}${sep}`)) failures.push(`新路径跑出了包目录：${to}`)
}
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

/** 递归列出源文件，跳过 node_modules、dist 与隐藏目录。 */
function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) return []
    const path = join(directory, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) return walk(path)
    return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(entry) ? [path] : []
  })
}

const SourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.mjs']

/** 按旧的文件布局把一个相对 import 解析成真实文件；解析不到返回 null。 */
function resolveOld(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base]
  if (/\.(?:js|mjs|cjs)$/u.test(base))
    candidates.push(
      base.replace(/\.(?:js|mjs|cjs)$/u, '.ts'),
      base.replace(/\.(?:js|mjs|cjs)$/u, '.tsx')
    )
  for (const extension of SourceExtensions) candidates.push(`${base}${extension}`)
  for (const extension of SourceExtensions) candidates.push(join(base, `index${extension}`))
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  )
}

/** 按原写法（带不带扩展名、带什么扩展名）生成指向新位置的相对路径。 */
function formatSpecifier(fromFile, targetFile, original) {
  let path = relative(dirname(fromFile), targetFile).split(sep).join('/')
  if (!path.startsWith('.')) path = `./${path}`
  const originalExtension = extname(original)
  const targetExtension = targetFile.endsWith('.d.ts') ? '.d.ts' : extname(targetFile)
  const withoutExtension = path.slice(0, path.length - targetExtension.length)
  if (/^\.(?:js|mjs|cjs)$/u.test(originalExtension))
    return `${withoutExtension}${originalExtension}`
  if (/^\.(?:ts|tsx|mts|cts)$/u.test(originalExtension)) return path
  return withoutExtension
}

/** 找出一个源文件里全部相对模块路径的位置（import、export from、import type、import()、require()）。 */
function relativeSpecifiers(file, text) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found = []
  const add = (literal) => {
    if (literal && ts.isStringLiteralLike(literal) && literal.text.startsWith('.'))
      found.push(literal)
  }
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(node.moduleSpecifier)
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal)
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0])
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found.map((literal) => ({
    start: literal.getStart(sourceFile) + 1,
    end: literal.getEnd() - 1,
    text: literal.text,
  }))
}

const files = [
  ...walk(join(RepoRoot, 'packages')),
  ...(existsSync(join(RepoRoot, 'tests')) ? walk(join(RepoRoot, 'tests')) : []),
  ...walk(join(RepoRoot, 'scripts')),
]
const rewrites = new Map()
let changedSpecifiers = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const specifiers = relativeSpecifiers(file, text)
  if (specifiers.length === 0) continue
  const newFile = moves.get(file) ?? file
  let output = ''
  let cursor = 0
  let changed = false
  for (const specifier of specifiers) {
    const target = resolveOld(file, specifier.text)
    if (!target) continue
    const newTarget = moves.get(target) ?? target
    if (newTarget === target && newFile === file) continue
    const replacement = formatSpecifier(newFile, newTarget, specifier.text)
    if (replacement === specifier.text) continue
    output += text.slice(cursor, specifier.start) + replacement
    cursor = specifier.end
    changed = true
    changedSpecifiers += 1
  }
  if (changed) rewrites.set(file, output + text.slice(cursor))
}

console.info(
  `搬 ${moves.size} 个文件，改写 ${rewrites.size} 个文件里的 ${changedSpecifiers} 处相对路径${dryRun ? '（演练，不落盘）' : ''}`
)
if (dryRun) process.exit(0)

for (const [source, target] of moves) {
  mkdirSync(dirname(target), { recursive: true })
  const tracked = execFileSync('git', ['ls-files', '--error-unmatch', source], {
    cwd: RepoRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim()
  if (!tracked) throw new Error(`没有纳入 git 的文件不搬：${source}`)
  execFileSync('git', ['mv', source, target], { cwd: RepoRoot })
}
for (const [file, text] of rewrites) writeFileSync(moves.get(file) ?? file, text)
console.info('完成')
