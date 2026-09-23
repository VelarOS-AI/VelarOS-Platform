#!/usr/bin/env node
// 产品代码里抛的错都从 core 造：`new AppError(code, message)`、要挂字段用 `AppError.withFields`、
// 取消与超时用 `createAbortError` / `createTimeoutError`（都在 @velaros-ai/core/error）。
// 这道门按语法树找原生 `new Error(...)` / `Error(...)`；字符串与注释里的不算（注入隔离堆的代码片段、模型面模版）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// 产品源码：测试、夹具、vendor、示例、构建产物与生成物不算。
const NotProductCode =
  /\/(test|tests|spec|vendor|fixtures|examples)\/|\.test\.|\.spec\.|\/dist\/|contract\/surface\.ts$|template\.js$|\.d\.ts$/

// 只有这些地方可以直接构造原生 Error，每条写明为什么绕不开。
const Exemptions = [
  {
    pattern: /^packages\/core\/src\/error\.ts$/,
    file: true,
    reason: 'core 的错误模块本身：AppError 与具名错误就在这里造',
  },
  {
    pattern: /^packages\/agent-lab\//,
    reason: 'agent-lab 是可独立消费的包，刻意不依赖 @velaros-ai/core',
  },
  {
    pattern: /^packages\/script\/src\/utils\/output-capture\.ts$/,
    file: true,
    reason: '整段经 toString() 注入 QuickJS 隔离堆，隔离堆里没有 core',
  },
  {
    pattern: /\/native\/build\.mjs$/,
    reason: '原生宿主的构建脚本，不进运行时，也不能假设 core 已经构建',
  },
]

const files = execFileSync(
  'git',
  // 还没 git add 的新文件也要查（--others），被忽略的不查
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    'packages/**/*.ts',
    'packages/**/*.mts',
    'packages/**/*.mjs',
    'packages/**/*.js',
  ],
  { cwd: repositoryRoot, encoding: 'utf8' }
)
  .split('\n')
  .filter((file) => file && !NotProductCode.test(file))

const violations = []
const exemptionHits = new Map(Exemptions.map((exemption) => [exemption, 0]))

for (const file of files) {
  const text = readFileSync(join(repositoryRoot, file), 'utf8')
  const kind = /\.m?js$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const found = []
  const visit = (node) => {
    const constructsError =
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Error'
    if (constructsError) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      found.push({
        line: line + 1,
        text: node.getText(sourceFile).replace(/\s+/gu, ' ').slice(0, 100),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (found.length === 0) continue
  const exemption = Exemptions.find((candidate) => candidate.pattern.test(file))
  if (exemption) {
    exemptionHits.set(exemption, exemptionHits.get(exemption) + found.length)
    continue
  }
  for (const hit of found) violations.push(`${file}:${hit.line}: ${hit.text}`)
}

// 单个文件的例外里已经没有原生 Error 了，就该把这条例外删掉，免得它变成以后的漏洞。
const staleExemptions = Exemptions.filter(
  (exemption) => exemption.file && exemptionHits.get(exemption) === 0
)

if (violations.length > 0 || staleExemptions.length > 0) {
  if (violations.length > 0) {
    console.error(`[error-construction] 失败：${violations.length} 处直接构造了原生 Error：`)
    for (const violation of violations) console.error(`  ${violation}`)
    console.error(
      '改用 @velaros-ai/core/error：new AppError(code, message)；要挂 effect 这类字段用 AppError.withFields(code, message, fields)；取消与超时用 createAbortError / createTimeoutError。'
    )
  }
  for (const exemption of staleExemptions)
    console.error(
      `[error-construction] 例外 ${exemption.pattern} 已经没有原生 Error 了，删掉这条例外`
    )
  process.exit(1)
}
console.log(
  `[error-construction] 通过。${files.length} 个产品源文件没有直接构造原生 Error（例外 ${Exemptions.length} 条，各写明理由）。`
)
