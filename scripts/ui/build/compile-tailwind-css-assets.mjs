#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { compile } from '@tailwindcss/node'

const targetDirectory = path.resolve(process.cwd(), process.argv[2] ?? 'dist')

async function collectCssFiles(directory) {
  const files = []
  for (const entry of await readdir(directory)) {
    const filePath = path.join(directory, entry)
    const fileStat = await stat(filePath)
    if (fileStat.isDirectory()) files.push(...(await collectCssFiles(filePath)))
    else if (filePath.endsWith('.css')) files.push(filePath)
  }
  return files
}

let compiledCount = 0
for (const filePath of await collectCssFiles(targetDirectory)) {
  if (path.basename(filePath) === 'tailwind-reference.css') continue
  const source = await readFile(filePath, 'utf8')
  const directivePattern = /^\s*@(apply|reference)\b/mu
  if (!directivePattern.test(source)) continue

  const compiler = await compile(source, {
    base: path.dirname(filePath),
    onDependency: () => undefined,
  })
  const compiled = compiler.build([])
  if (directivePattern.test(compiled)) {
    throw new Error(`Tailwind directives remain in ${filePath}`)
  }
  await writeFile(filePath, compiled)
  compiledCount += 1
}

console.info(
  `compile-tailwind-css-assets: compiled ${compiledCount} stylesheet(s) under ${targetDirectory}.`
)
