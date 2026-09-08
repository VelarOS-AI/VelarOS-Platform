#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromOffice = createRequire(join(repositoryRoot, 'packages/office/package.json'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function assertVendoredPptxGenJs() {
  const officePackagePath = join(repositoryRoot, 'packages/office/package.json')
  const rootPackagePath = join(repositoryRoot, 'package.json')
  const officePackage = JSON.parse(readFileSync(officePackagePath, 'utf8'))
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'))
  const runtimePath = join(repositoryRoot, 'packages/office/vendor/pptxgenjs/pptxgen.es.js')
  const typesPath = join(repositoryRoot, 'packages/office/vendor/pptxgenjs/pptxgen.es.d.ts')
  const runtime = readFileSync(runtimePath)
  const types = readFileSync(typesPath)
  const runtimeText = runtime.toString('utf8')
  const typesText = types.toString('utf8')

  assert(!officePackage.dependencies?.pptxgenjs, 'Office must use the audited vendored PptxGenJS runtime')
  assert(!rootPackage.patchedDependencies?.['image-size@1.2.1'], 'The obsolete image-size patch must stay removed')
  assert(runtimeText.startsWith('/* PptxGenJS 4.0.1 '), 'Vendored PptxGenJS runtime version changed')
  assert(typesText.startsWith('// Type definitions for pptxgenjs 4.0.1'), 'Vendored PptxGenJS types version changed')
  assert(runtimeText.includes("import JSZip from 'jszip';"), 'Vendored PptxGenJS must keep JSZip external')
  assert(runtimeText.includes("typeof globalThis.crypto.getRandomValues !== 'function'"), 'Vendored PptxGenJS Web Crypto UUID patch is missing')
  assert(runtimeText.includes('resolvePresentationArchiveTarget(rel.Target)'), 'Vendored PptxGenJS archive path patch is missing')
  assert(!/image-size/i.test(runtimeText), 'Vendored PptxGenJS unexpectedly references image-size')
  assert(
    sha256(runtime) === '1d5b4af9da57182a1b6c3f7308c5cefe32d3b034709ceb2b95c7f0b7c60565f4',
    'Vendored PptxGenJS patched runtime changed; review the upstream and local security diffs',
  )
  assert(
    sha256(types) === 'af809be35683161be19ef8e415afc469b4f94b661bd8bb2255d1276166eb7023',
    'Vendored PptxGenJS upstream type declarations changed; review the public API diff',
  )
}

function collectJavaScriptFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const entryPath = join(directory, entry)
    if (statSync(entryPath).isDirectory()) files.push(...collectJavaScriptFiles(entryPath))
    else if (entry.endsWith('.js')) files.push(entryPath)
  }
  return files
}

function assertExcelJsUsesOnlyUuidV4() {
  const excelJsRoot = dirname(requireFromOffice.resolve('exceljs/package.json'))
  const uuidImports = collectJavaScriptFiles(join(excelJsRoot, 'lib'))
    .map((filePath) => ({ filePath, content: readFileSync(filePath, 'utf8') }))
    .filter(({ content }) => /require\(['"]uuid['"]\)/.test(content))

  assert(uuidImports.length === 1, `Expected one ExcelJS uuid call site, found ${uuidImports.length}`)
  const [{ filePath, content }] = uuidImports
  assert(
    /\{\s*v4:\s*uuidv4\s*\}\s*=\s*require\(['"]uuid['"]\)/.test(content),
    `ExcelJS uuid usage changed at ${filePath}; reassess CVE-2026-41907`,
  )
  assert(!/\b(?:v3|v5|v6)\s*[:(]/.test(content), 'ExcelJS now uses a uuid API covered by CVE-2026-41907')
}

assertVendoredPptxGenJs()
assertExcelJsUsesOnlyUuidV4()

console.log('Dependency security probes passed.')
