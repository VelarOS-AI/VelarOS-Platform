#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromOffice = createRequire(join(repositoryRoot, 'packages/office/package.json'))
const requireFromPptxGen = createRequire(requireFromOffice.resolve('pptxgenjs'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function runImageProbe(label, input) {
  const imageSizeEntry = requireFromPptxGen.resolve('image-size')
  const probe = [
    `const imageSize = require(${JSON.stringify(imageSizeEntry)})`,
    `const input = Buffer.from(${JSON.stringify(input.toString('base64'))}, 'base64')`,
    "try { imageSize(input); process.exitCode = 2 } catch { process.exitCode = 0 }",
  ].join(';')
  const result = spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    timeout: 1_000,
  })
  assert(!result.error, `${label}: parser did not terminate safely (${result.error?.message})`)
  assert(result.status === 0, `${label}: malformed input was not rejected`)
}

function createMalformedIcns() {
  const input = Buffer.alloc(16)
  input.write('icns', 0, 'ascii')
  input.writeUInt32BE(input.length, 4)
  input.write('ic07', 8, 'ascii')
  input.writeUInt32BE(0, 12)
  return input
}

function createMalformedJxl() {
  const input = Buffer.alloc(24)
  input.writeUInt32BE(12, 0)
  input.write('JXL ', 4, 'ascii')
  input.writeUInt32BE(0, 12)
  input.write('loop', 16, 'ascii')
  return input
}

function createMalformedHeif() {
  const input = Buffer.alloc(24)
  input.writeUInt32BE(16, 0)
  input.write('ftyp', 4, 'ascii')
  input.write('heic', 8, 'ascii')
  input.writeUInt32BE(0, 16)
  input.write('loop', 20, 'ascii')
  return input
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

runImageProbe('ICNS zero-length entry', createMalformedIcns())
runImageProbe('JXL zero-length box', createMalformedJxl())
runImageProbe('HEIF zero-length box', createMalformedHeif())
assertExcelJsUsesOnlyUuidV4()

console.log('Patched dependency probes passed.')
