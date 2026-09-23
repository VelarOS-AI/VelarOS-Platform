#!/usr/bin/env node
// 模块 README「用法」里的 ts 示例按真实公开类型做类型检查：示例只从公开入口 import，宿主提供的东西写成 declare const。
// 规范见 docs/architecture/module-readme.md。用法：node scripts/ownership/check-readme-examples.mjs [模块名…]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { GovernedModules } from './governed-modules.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const only = new Set(process.argv.slice(2))

/** 模块根目录：普通包是包目录，单元是单元目录（登记了 root 时是 root）。 */
function moduleRoot(module) {
  const packageRoot = join(repositoryRoot, 'packages', module.directory)
  return module.unit ? join(packageRoot, module.root ?? module.unit) : packageRoot
}

/** 取出「## 用法」一节里的 ts 代码块和它在 README 里的起始行。 */
function usageExamples(markdown) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## 用法')
  if (start < 0) return []
  const examples = []
  let fence = null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!fence && /^## /u.test(line)) break
    if (!fence && /^```(ts|typescript)\s*$/u.test(line)) fence = { line: index + 1, body: [] }
    else if (fence && /^```\s*$/u.test(line)) {
      examples.push({ line: fence.line, source: fence.body.join('\n') })
      fence = null
    } else if (fence) fence.body.push(line)
  }
  return examples
}

const parsed = ts.getParsedCommandLineOfConfigFile(
  join(repositoryRoot, 'tsconfig.json'),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  }
)
// 根 tsconfig 只给源码路径映射；编译选项与各包 tsconfig 一致（示例按外部宿主的写法：ES 模块、顶层 await、严格模式）。
const options = {
  ...parsed.options,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
}
// 每个包的公开入口都映射回源码（dist 路径按包的 rootDir 换回 .ts），示例查的是当前源码，不依赖 dist 新不新
options.paths = { ...options.paths, ...sourcePaths() }
options.baseUrl = repositoryRoot

/** 从各包 package.json 的 exports 推出「import 名 → 源码文件」映射。 */
function sourcePaths() {
  const paths = {}
  for (const directory of readdirSync(join(repositoryRoot, 'packages'))) {
    const packageRoot = join(repositoryRoot, 'packages', directory)
    if (!existsSync(join(packageRoot, 'package.json'))) continue
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    const buildConfig = join(packageRoot, 'tsconfig.build.json')
    const rootDir = existsSync(buildConfig)
      ? (JSON.parse(readFileSync(buildConfig, 'utf8')).compilerOptions?.rootDir ?? '.')
      : '.'
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const built = typeof target === 'string' ? target : (target.import ?? target.default)
      if (typeof built !== 'string' || !built.startsWith('./dist/')) continue
      const source = join(
        'packages',
        directory,
        rootDir,
        built.slice('./dist/'.length).replace(/\.js$/u, '.ts')
      )
      paths[subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`] = [source]
    }
  }
  return paths
}

// 源码里用到的全局别名（Nullable、Optional…），各包自带同一份声明
const globals = join(repositoryRoot, 'packages/core/src/velaros-globals.d.ts')

// 每段示例是一份虚拟模块，放在所属 README 旁边，相对路径与包解析都照真实位置走。
const virtual = new Map()
for (const module of GovernedModules) {
  if (only.size && !only.has(module.name)) continue
  const readmePath = join(moduleRoot(module), 'README.md')
  if (!existsSync(readmePath)) continue
  usageExamples(readFileSync(readmePath, 'utf8')).forEach((example, index) => {
    const file = join(dirname(readmePath), `__readme_example_${index + 1}.ts`)
    virtual.set(file, {
      module: module.name,
      readmePath,
      line: example.line,
      source: `${example.source}\nexport {}\n`,
    })
  })
}

const host = ts.createCompilerHost(options, true)
const readFile = host.readFile.bind(host)
const fileExists = host.fileExists.bind(host)
const getSourceFile = host.getSourceFile.bind(host)
host.readFile = (file) => virtual.get(resolve(file))?.source ?? readFile(file)
host.fileExists = (file) => virtual.has(resolve(file)) || fileExists(file)
host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
  const entry = virtual.get(resolve(file))
  return entry
    ? ts.createSourceFile(file, entry.source, languageVersion, true, ts.ScriptKind.TS)
    : getSourceFile(file, languageVersion, onError, shouldCreate)
}

const program = ts.createProgram([globals, ...virtual.keys()], options, host)
const problems = []
for (const [file, entry] of virtual) {
  const sourceFile = program.getSourceFile(file)
  for (const diagnostic of [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ]) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
    problems.push(
      `${relative(repositoryRoot, entry.readmePath)}:${entry.line + line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
    )
  }
}

if (problems.length) {
  console.error(`[readme-examples] 失败：${problems.length} 处示例和真实类型对不上：`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`[readme-examples] 通过。${virtual.size} 段示例按真实公开类型检查无误。`)
